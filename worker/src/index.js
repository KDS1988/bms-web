/**
 * Cloudflare Worker: единственная точка, которая ходит в BMS.
 * Фронтенд (GitHub Pages) получает только готовые данные и не видит токенов BMS.
 */
import { BmsClient, fetchAssignments, assignEmployee, VR_LINE_NAME } from './bms.js';
import { buildBoard } from './board.js';
import { buildStaff, buildCandidates, dateRange } from './staff.js';
import { findMissingRates, fixRates } from './rates.js';
import { verifyGoogleIdToken, signSession, verifySession, roleFor, hasRole } from './auth.js';
import { LOGIN_REQUIRED } from './session.js';

export { BmsSession } from './session.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : (allowed[0] || ''),
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });

function checkRange(from, to) {
  if (!ISO.test(from || '') || !ISO.test(to || '')) throw new HttpError(400, 'Нужны даты from и to в формате ГГГГ-ММ-ДД');
  if (from > to) throw new HttpError(400, 'Дата «с» позже даты «по»');
  if (dateRange(from, to).length > MAX_RANGE_DAYS) throw new HttpError(400, `Период не больше ${MAX_RANGE_DAYS} дней`);
}

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Некорректный JSON'); }
}

let jwksCache = { at: 0, data: null };
async function fetchJwks() {
  if (jwksCache.data && Date.now() - jwksCache.at < 3600_000) return jwksCache.data;
  const r = await fetch(GOOGLE_JWKS);
  if (!r.ok) throw new Error('jwks_unavailable');
  jwksCache = { at: Date.now(), data: await r.json() };
  return jwksCache.data;
}

function sessionStub(env) {
  return env.BMS_SESSION.get(env.BMS_SESSION.idFromName('main'));
}

function makeClient(env) {
  const stub = sessionStub(env);
  return new BmsClient(force => stub.getAccessToken(force));
}

/** BMS ждёт только цифры (11–12): «8 926 877-77-45» -> 79268777745. */
export function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}

// короткий кэш на стороне Worker: несколько человек не бомбят BMS одинаковыми запросами
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), p });
  return p;
}
const clearCache = () => cache.clear();

const asList = d => (Array.isArray(d) ? d : (d && (d.items || d.results)) || []);

async function loadLines(client) {
  return asList(await client.get('admin/catalog/line/list', { page: 1, size: 100 }));
}

async function loadSchedule(client, lines, from, to) {
  const entriesByLine = await Promise.all(lines.map(async line => ({
    line: { id: line.id, name: line.name },
    entries: asList(await client.get('admin/employee/schedule', {
      date_from: from, date_to: to, 'line_id__in': line.id,
    })),
  })));
  return entriesByLine;
}

async function route(req, env, url) {
  const path = url.pathname;

  // ---- вход
  if (path === '/api/auth/google' && req.method === 'POST') {
    const { credential } = await body(req);
    let who;
    try {
      who = await verifyGoogleIdToken(credential, { clientId: env.GOOGLE_CLIENT_ID, fetchJwks });
    } catch (e) {
      throw new HttpError(401, 'Не удалось подтвердить вход через Google');
    }
    const role = roleFor(who.email, env);
    if (!role) throw new HttpError(403, `Нет доступа для ${who.email}. Попросите администратора добавить вас в список.`);
    const token = await signSession({ email: who.email, name: who.name, role }, env.SESSION_SECRET);
    return { token, user: { email: who.email, name: who.name, role } };
  }

  // ---- всё остальное — только с сессией
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = await verifySession(auth, env.SESSION_SECRET);
  if (!user) throw new HttpError(401, 'Сессия истекла — войдите заново');
  // роль перечитываем из env: удалили из списка — доступ пропал сразу
  const role = roleFor(user.email, env);
  if (!role) throw new HttpError(403, 'Доступ отозван');
  const need = r => { if (!hasRole(role, r)) throw new HttpError(403, 'Недостаточно прав'); };

  if (path === '/api/me') return { user: { email: user.email, name: user.name, role } };

  // ---- администрирование сессии BMS
  if (path === '/api/admin/bms/status') { need('admin'); return sessionStub(env).status(); }
  if (path === '/api/admin/bms/otp' && req.method === 'POST') {
    need('admin');
    const { phone } = await body(req);
    return sessionStub(env).requestOtp(normalizePhone(phone));
  }
  if (path === '/api/admin/bms/login' && req.method === 'POST') {
    need('admin');
    const { phone, code } = await body(req);
    return sessionStub(env).login(normalizePhone(phone), String(code || '').trim(), user.email);
  }

  const client = makeClient(env);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (path === '/api/board') {
    need('viewer'); checkRange(from, to);
    const all = url.searchParams.get('all') === '1';
    return cached(`board|${from}|${to}|${all}`, 15_000, async () => buildBoard(await fetchAssignments(client, from, to), { all }));
  }

  if (path === '/api/staff') {
    need('viewer'); checkRange(from, to);
    return cached(`staff|${from}|${to}`, 300_000, async () => {
      const lines = await loadLines(client);
      return buildStaff(await loadSchedule(client, lines, from, to), dateRange(from, to));
    });
  }

  if (path === '/api/employees') {
    need('viewer');
    const date = url.searchParams.get('date');
    const lineId = Number(url.searchParams.get('lineId'));
    if (!ISO.test(date || '') || !lineId) throw new HttpError(400, 'Нужны date и lineId');
    return cached(`cand|${date}|${lineId}`, 60_000, async () => {
      const entries = asList(await client.get('admin/employee/schedule', {
        date_from: date, date_to: date, 'line_id__in': lineId,
      }));
      return { candidates: buildCandidates(entries, date, lineId), fetchedAt: new Date().toISOString() };
    });
  }

  // ---- общий черновик
  if (path === '/api/draft' && req.method === 'GET') {
    need('viewer');
    const since = url.searchParams.get('since');
    return sessionStub(env).drafts(since === null ? null : Number(since));
  }
  if (path === '/api/draft' && req.method === 'POST') {
    need('editor');
    const b = await body(req);
    const n = k => Number(b[k]);
    if (![n('eventServiceId'), n('lineId'), n('employeeId')].every(x => Number.isInteger(x) && x > 0)) throw new HttpError(400, 'Некорректные идентификаторы');
    const key = `${n('eventServiceId')}:${n('lineId')}`;
    const str = (v, max) => String(v == null ? '' : v).slice(0, max);
    await sessionStub(env).draftSet(key, {
      eventServiceId: n('eventServiceId'), lineId: n('lineId'), roleId: Number(b.roleId) || null,
      roleName: str(b.roleName, 80), date: str(b.date, 10), title: str(b.title, 160),
      employeeId: n('employeeId'), employeeName: str(b.employeeName, 120), state: str(b.state, 8),
      replaceAssignmentId: Number(b.replaceAssignmentId) > 0 ? Number(b.replaceAssignmentId) : null,
      prevName: str(b.prevName, 120),
      by: user.name || user.email, at: new Date().toISOString(),
    });
    return { ok: true };
  }
  if (path === '/api/draft/delete' && req.method === 'POST') {
    need('editor');
    const { keys, all } = await body(req);
    await sessionStub(env).draftDelete(all === true ? '*' : (Array.isArray(keys) ? keys.map(String).slice(0, 500) : []));
    return { ok: true };
  }

  if (path === '/api/assign' && req.method === 'POST') {
    need('editor');
    const b = await body(req);
    const ids = ['eventServiceId', 'lineId', 'employeeId'].map(k => Number(b[k]));
    if (ids.some(n => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'Некорректные идентификаторы');
    const replaceId = Number(b.replaceAssignmentId) > 0 ? Number(b.replaceAssignmentId) : null;
    const isVr = String(b.lineName || '').trim() === VR_LINE_NAME;
    const stub = sessionStub(env);
    try {
      if (replaceId) {
        // замена: сначала снимаем прежнего. Если BMS откажет — ничего не меняется.
        try { await client.delete(`projects/assignment/technical/${replaceId}`); }
        catch (e) { throw new HttpError(409, 'Не удалось снять прежнего исполнителя в BMS: ' + String(e.message).slice(0, 200)); }
      }
      let res;
      try {
        res = await assignEmployee(client, { eventServiceId: ids[0], lineId: ids[1], employeeId: ids[2], isVr });
      } catch (e) {
        if (replaceId && !(e.name === 'AlreadyExistsError')) {
          throw new HttpError(502, 'Прежний исполнитель снят, но нового назначить не удалось: ' + String(e.message).slice(0, 200) + ' — назначьте вручную.');
        }
        throw e;
      }
      console.log(JSON.stringify({ evt: 'assign', by: user.email, ...b, rate: res.rate }));
      await stub.draftDelete([`${ids[0]}:${ids[1]}`]);
      await stub.bumpBoard(); clearCache();
      return res;
    } catch (e) {
      if (e.name === 'AlreadyExistsError') {
        await stub.draftDelete([`${ids[0]}:${ids[1]}`]);
        throw new HttpError(409, 'Такое назначение уже есть в BMS');
      }
      throw e;
    }
  }

  if (path === '/api/rates/missing') {
    need('viewer'); checkRange(from, to);
    return { missing: findMissingRates(await fetchAssignments(client, from, to)) };
  }

  if (path === '/api/rates/fix' && req.method === 'POST') {
    need('editor');
    const { from: f, to: t } = await body(req);
    checkRange(f, t);
    // список пересчитываем на сервере — не доверяем тому, что пришло из браузера
    const missing = findMissingRates(await fetchAssignments(client, f, t));
    const res = await fixRates(client, missing);
    clearCache(); await sessionStub(env).bumpBoard();
    console.log(JSON.stringify({ evt: 'fixRates', by: user.email, fixed: res.fixed.length, failed: res.failed.length }));
    return res;
  }

  throw new HttpError(404, 'Не найдено');
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    try {
      return json(await route(req, env, url), 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      const msg = String(e && e.message || e);
      if (msg.includes(LOGIN_REQUIRED)) {
        return json({ error: 'Сессия BMS не активна. Администратор должен войти в BMS (раздел «Настройки»).', code: 'bms_login' }, 503, cors);
      }
      console.error(msg);
      return json({ error: 'Ошибка BMS: ' + msg.slice(0, 300) }, 502, cors);
    }
  },
};
