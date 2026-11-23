/**
 * Cloudflare Worker: единственная точка, которая ходит в BMS.
 * Фронтенд (GitHub Pages) получает только готовые данные и не видит токенов BMS.
 */
import { BmsClient, fetchAssignments, assignEmployee, updateAssignment, VR_LINE_NAME } from './bms.js';
import { buildBoard, roleGroupKey } from './board.js';
import { sanitizePlan } from './plans.js';
import { parseSourceRow, sanitizePatch, buildVrStats, autoLabel, VR_LABELS } from './studios.js';
import { buildStaff, buildCandidates, buildCandidatesFromList, dateRange } from './staff.js';
import { findMissingRates, fixRates } from './rates.js';
import { FhmError, loadFhmCalendar, parseFhmCrewEdit, verifyFhmKey, withCalendarAddresses } from './fhm.js';
import { verifyGoogleIdToken, signSession, verifySession, roleFor, hasSection, parseUserAccess } from './auth.js';
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
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });

function checkRange(from, to) {
  if (!ISO.test(from || '') || !ISO.test(to || '')) throw new HttpError(400, 'Нужны даты from и to в формате ГГГГ-ММ-ДД');
  const start = new Date(from), end = new Date(to);
  if (isNaN(start) || isNaN(end) || start.toISOString().slice(0, 10) !== from || end.toISOString().slice(0, 10) !== to) {
    throw new HttpError(400, 'Некорректная дата');
  }
  if (from > to) throw new HttpError(400, 'Дата «с» позже даты «по»');
  if ((end - start) / 86400000 >= MAX_RANGE_DAYS) throw new HttpError(400, `Период не больше ${MAX_RANGE_DAYS} дней`);
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

async function effectiveAccess(email, env) {
  const fixed = roleFor(email, env);
  return fixed ? { role: fixed } : sessionStub(env).userAccess(email);
}

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

async function gzip(str) {
  return new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function gunzip(u8) {
  return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// Снимок месяца: один запрос в BMS на всех, остальные получают готовое из хранилища.
const inflightBoard = new Map();
function buildFresh(env, client, key, from, to, all) {
  if (inflightBoard.has(key)) return inflightBoard.get(key);
  const p = (async () => {
    const t0 = Date.now();
    const items = await fetchAssignments(client, from, to);
    const board = buildBoard(items, { all });
    board.meta = { items: items.length, fetchMs: Date.now() - t0 };
    board.generatedAt = Date.now();
    await sessionStub(env).snapPut(key, board.generatedAt, await gzip(JSON.stringify(board)));
    return board;
  })().finally(() => inflightBoard.delete(key));
  inflightBoard.set(key, p);
  return p;
}

function studioBoardView({ days, stale, generatedAt }) {
  return {
    stale, generatedAt,
    days: days.map(({ date, rows }) => ({
      date,
      rows: rows.map(({ eventId, eventServiceId, date, start, title, league, service, slots }) => ({
        eventId, eventServiceId, date, start, title, league, service,
        slots: { vr: slots.vr.map(({ roleName, lineId, roleId, assignmentId, status, employee }) => ({
          roleName, lineId, roleId, assignmentId, status, employee: employee ? { name: employee.name } : null,
        })) },
      })),
    })),
  };
}

async function route(req, env, url, ctx) {
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
    const access = await effectiveAccess(who.email, env);
    if (!access) {
      await sessionStub(env).requestAccess(who.email, who.name);
      throw new HttpError(403, `Запрос на доступ для ${who.email} отправлен администратору. Как только его одобрят, войдите снова.`, { code: 'pending' });
    }
    const token = await signSession(who, env.SESSION_SECRET);
    return { token, user: { ...who, ...access } };
  }

  // ---- всё остальное — только с сессией
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = await verifySession(auth, env.SESSION_SECRET);
  if (!user) throw new HttpError(401, 'Сессия истекла — войдите заново');
  const access = await effectiveAccess(user.email, env);
  if (!access) throw new HttpError(403, 'Доступ отозван', { code: 'access_revoked' });
  const deny = () => { throw new HttpError(403, 'Недостаточно прав', { code: 'access_denied' }); };
  const admin = () => { if (access.role !== 'admin') deny(); };
  const need = (section, level) => { if (!hasSection(access, section, level)) deny(); };

  if (path === '/api/me') return { user: { email: user.email, name: user.name, ...access } };

  // ---- администрирование сессии BMS
  if (path.startsWith('/api/admin/users')) {
    admin();
    const stub = sessionStub(env);
    if (path === '/api/admin/users' && req.method === 'GET') {
      const l = await stub.usersList();
      const fixed = ['ADMIN_EMAILS', 'EDITOR_EMAILS', 'VIEWER_EMAILS'].flatMap(k => String(env[k] || '').split(',').map(x => x.trim()).filter(Boolean));
      return { owners: [...new Set(fixed)], users: l.users, requests: l.requests };
    }
    if (req.method === 'POST') {
      const data = await body(req);
      const email = data?.email;
      const e = String(email || '').trim().toLowerCase();
      if (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, 'Некорректный email');
      if (roleFor(e, env)) throw new HttpError(400, 'Доступ этого пользователя задан в настройках сервера');
      if (path === '/api/admin/users/access') {
        const grant = parseUserAccess(data);
        if (!grant) throw new HttpError(400, 'Выберите хотя бы один раздел или права администратора');
        await stub.userSetAccess(e, grant, user.email);
        console.log(JSON.stringify({ evt: 'userAccess', by: user.email, email: e, ...grant }));
      } else if (path === '/api/admin/users/reject') await stub.userReject(e);
      else if (path === '/api/admin/users/remove') { await stub.userRemove(e); console.log(JSON.stringify({ evt: 'userRemove', by: user.email, email: e })); }
      else throw new HttpError(404, 'Не найдено');
      return { ok: true };
    }
  }

  if (path === '/api/admin/bms/status') { admin(); return sessionStub(env).status(); }
  if (path === '/api/admin/bms/otp' && req.method === 'POST') {
    admin();
    const { phone } = await body(req);
    return sessionStub(env).requestOtp(normalizePhone(phone));
  }
  if (path === '/api/admin/bms/login' && req.method === 'POST') {
    admin();
    const { phone, code } = await body(req);
    return sessionStub(env).login(normalizePhone(phone), String(code || '').trim(), user.email);
  }

  if (path === '/api/admin/fhm' && ['GET', 'POST'].includes(req.method)) {
    admin();
    const stub = sessionStub(env);
    if (req.method === 'GET') return { configured: !!(await stub.fhmConfig()) };
    const data = await body(req);
    const key = typeof data?.key === 'string' ? data.key.trim() : '';
    if (key.length > 256 || !/^[\w-]+\.[\w-]+$/.test(key)) throw new HttpError(400, 'Введите ключ ФХМ в формате prefix.secret');
    try {
      await verifyFhmKey(key);
    } catch (e) {
      if (e instanceof FhmError && [401, 403].includes(e.status)) throw new HttpError(400, e.message);
      throw e;
    }
    await stub.fhmConfigSet({ key, revision: crypto.randomUUID() });
    return { configured: true };
  }

  if (['/api/fhm/calendar', '/api/fhm/schedule'].includes(path) && req.method === 'GET') {
    const schedule = path === '/api/fhm/schedule';
    need(schedule ? 'fhm-schedule' : 'fhm-calendar');
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    checkRange(from, to);
    const stub = sessionStub(env);
    const config = await stub.fhmConfig();
    if (!config) throw new HttpError(503, 'Календарь ФХМ ещё не подключён. Ключ сохраняется в разделе «Админ» → «ДХ: календарь ФХМ».', { code: 'fhm_not_configured' });
    const [calendar, crews] = await Promise.all([
      cached(`fhm|${config.revision}|${from}|${to}`, 60_000,
        async () => withCalendarAddresses(await loadFhmCalendar(config.key, from, to),
          venues => stub.fhmVenueAddresses(venues))),
      schedule || hasSection(access, 'fhm-schedule') ? stub.fhmCrews(dateRange(from, to)) : {},
    ]);
    if (schedule && !hasSection(access, 'fhm-calendar')) {
      const matches = calendar.matches.map(({ id, date, time, duration, year, venue, venueId, location, status, copy }) =>
        ({ id, date, time, duration, year, venue, venueId, location, status, copy }));
      return { matches, crews };
    }
    return { ...calendar, crews };
  }

  if (path === '/api/fhm/crew' && req.method === 'POST') {
    need('fhm-schedule', 'editor');
    const edit = parseFhmCrewEdit(await body(req));
    if (!edit) throw new HttpError(400, 'Некорректные данные бригады');
    checkRange(edit.date, edit.date);
    await sessionStub(env).fhmCrewSet(edit);
    return { value: edit.value };
  }

  const client = makeClient(env);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (path === '/api/board' || path === '/api/studios/board') {
    const studioBoard = path === '/api/studios/board';
    need(studioBoard ? 'studios' : 'board'); checkRange(from, to);
    const all = studioBoard || url.searchParams.get('all') === '1';
    const project = data => studioBoard ? studioBoardView(data) : data;
    const key = `board|${from}|${to}|${all}`;
    if (url.searchParams.get('fresh') !== '1') {
      const snap = await sessionStub(env).snapGet(key);
      if (snap.data) {
        const board = JSON.parse(await gunzip(snap.data));
        const stale = snap.at < snap.lw || Date.now() - snap.at > 20_000;   // после записи в BMS или старше 20 с
        if (stale && Date.now() - snap.at > 60_000) {
          // снимок старый — ждём свежий сами; если BMS не отвечает, честно говорим об этом
          try { return project({ ...(await buildFresh(env, client, key, from, to, all)), stale: false }); }
          catch (e) { return project({ ...board, stale: true, refreshError: String(e.message || e).slice(0, 200) }); }
        }
        if (stale) ctx.waitUntil(buildFresh(env, client, key, from, to, all).catch(e => console.error('refresh', String(e))));
        return project({ ...board, stale });
      }
    }
    return project({ ...(await buildFresh(env, client, key, from, to, all)), stale: false });
  }

  if (path === '/api/order') {
    if (req.method === 'POST') {
      need('board', 'editor');
      const b = await body(req);
      if (!ISO.test(b.date || '') || !Array.isArray(b.ids)) throw new HttpError(400, 'Нужны date и ids');
      const clean = arr => arr.map(Number).filter(n => Number.isInteger(n) && n !== 0).slice(0, 300);
      // раскладка колонками [[id…],[id…]] (или старый плоский список)
      const ids = b.ids.length && Array.isArray(b.ids[0])
        ? b.ids.slice(0, 40).map(c => clean(Array.isArray(c) ? c : [])).filter(c => c.length)
        : clean(b.ids);
      await sessionStub(env).orderSet(b.date, ids);
      return { ok: true };
    }
    need('board'); checkRange(from, to);
    return { orders: await sessionStub(env).orderGet(from, to) };
  }

  if (path === '/api/staff') {
    need('board'); checkRange(from, to);
    return cached(`staff|${from}|${to}`, 300_000, async () => {
      const lines = await loadLines(client);
      return buildStaff(await loadSchedule(client, lines, from, to), dateRange(from, to));
    });
  }

  if (path === '/api/employees') {
    need('board');
    const date = url.searchParams.get('date');
    const lineId = Number(url.searchParams.get('lineId'));
    if (!ISO.test(date || '') || !lineId) throw new HttpError(400, 'Нужны date и lineId');
    return cached(`cand|${date}|${lineId}`, 60_000, async () => {
      const list = asList(await client.get('users/user/employee_list', { line_id: lineId, date }));
      return { candidates: buildCandidatesFromList(list, lineId), fetchedAt: new Date().toISOString() };
    });
  }

  // ---- справочник ролей (для состава мероприятия-черновика)
  if (path === '/api/lines') {
    need('board');
    return cached('lines', 3_600_000, async () => ({
      lines: (await loadLines(client)).map(l => ({ id: l.id, name: l.name, group: roleGroupKey(l.name) })),
    }));
  }

  // ---- мероприятия-черновики
  if (path === '/api/plans' && req.method === 'GET') {
    need('board'); checkRange(from, to);
    const st = sessionStub(env);
    const [plans, trips] = await Promise.all([st.plansGet(from, to), st.tripsGet(from, to)]);
    return { plans, trips };
  }
  if (path === '/api/trips' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    if (!/^[ep]\d{1,12}$/.test(String(b.key || '')) || !ISO.test(b.date || '')) throw new HttpError(400, 'Некорректные данные');
    await sessionStub(env).tripSet(String(b.key), b.date, b.on === true, user.name || user.email);
    return { ok: true };
  }
  if (path === '/api/plans' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    const r = sanitizePlan(b);
    if (r.error) throw new HttpError(400, r.error);
    const id = Number(b.id) > 0 ? Number(b.id) : null;
    const plan = await sessionStub(env).planSave(id, r.plan, user.name || user.email);
    if (!plan) throw new HttpError(404, 'Такого мероприятия-черновика уже нет');
    return { plan };
  }
  if (path === '/api/plans/delete' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    if (!(Number(b.id) > 0)) throw new HttpError(400, 'Нужен id');
    await sessionStub(env).planDelete(Number(b.id));
    return { ok: true };
  }

  // ---- СТУДИИ
  if (path === '/api/studios' && req.method === 'GET') {
    need('studios'); checkRange(from, to);
    const r = await sessionStub(env).studiosGet(from, to);
    return { ...r, matches: r.matches.filter(m => !m.hidden) };
  }
  if (path === '/api/studios/source') {
    admin();
    const st = sessionStub(env);
    if (req.method === 'POST') {
      const b = await body(req);
      const u = String(b.url || '').trim(), k = String(b.key || '').trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) throw new HttpError(400, 'Нужна ссылка веб-приложения Apps Script (…/exec)');
      if (!k) throw new HttpError(400, 'Нужен ключ');
      await st.studiosSrcSet({ url: u, key: k });
      return { ok: true };
    }
    const src = await st.studiosSrcGet();
    return { configured: !!src, url: src ? src.url : '' };
  }
  if (path === '/api/studios/sync' && req.method === 'POST') {
    need('studios', 'editor');
    return syncStudios(env, user.name || user.email);
  }
  if (path === '/api/studios' && req.method === 'POST') {
    need('studios', 'editor');
    const b = await body(req);
    const r = sanitizePatch(b, !b.id);
    if (r.error) throw new HttpError(400, r.error);
    const m = await sessionStub(env).studiosSave(b.id ? String(b.id) : null, r.patch, user.name || user.email);
    if (!m) throw new HttpError(404, 'Такого матча уже нет');
    return { match: m };
  }
  if (path === '/api/studios/delete' && req.method === 'POST') {
    need('studios', 'editor');
    const b = await body(req);
    if (!(await sessionStub(env).studiosDelete(String(b.id || '')))) throw new HttpError(404, 'Такого матча уже нет');
    return { ok: true };
  }

  if (path === '/api/studios/vr' && req.method === 'GET') {
    need('studios');
    const { stats, at, manual } = await sessionStub(env).vrGet();
    const today = new Date().toISOString().slice(0, 10);
    const vrs = Object.entries(stats).map(([name, e]) => {
      const auto = autoLabel(e, today), man = manual[name] ? manual[name].label : '';
      return { name, n: e.n, bad: e.bad, first: e.first, last: e.last, proj: e.proj, auto, manual: man, label: man || auto };
    }).sort((a, b) => b.n - a.n);
    // ВР, у которых есть только ручная метка (в истории нет)
    for (const [name, m] of Object.entries(manual)) if (!stats[name]) vrs.push({ name, n: 0, bad: 0, first: today, last: today, proj: {}, auto: 'новичок', manual: m.label, label: m.label });
    return { vrs, at };
  }
  if (path === '/api/studios/vr/label' && req.method === 'POST') {
    admin();
    const b = await body(req);
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 80), label = String(b.label || '');
    if (!name || !VR_LABELS.includes(label)) throw new HttpError(400, 'Некорректные данные');
    await sessionStub(env).vrLabelSet(name, label, user.name || user.email);
    return { ok: true };
  }
  if (path === '/api/studios/history/sync' && req.method === 'POST') {
    need('studios', 'editor');
    return syncVrHistory(env);
  }

  // ---- общий черновик
  if (path === '/api/draft' && req.method === 'GET') {
    need('board');
    const since = url.searchParams.get('since');
    return sessionStub(env).drafts(since === null ? null : Number(since));
  }
  if (path === '/api/draft' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    const n = k => Number(b[k]);
    if (![n('lineId'), n('employeeId')].every(x => Number.isInteger(x) && x > 0) || !Number.isInteger(n('eventServiceId')) || n('eventServiceId') === 0) throw new HttpError(400, 'Некорректные идентификаторы');
    const key = `${n('eventServiceId')}:${n('lineId')}`;
    const str = (v, max) => String(v == null ? '' : v).slice(0, max);
    await sessionStub(env).draftSet(key, {
      eventServiceId: n('eventServiceId'), lineId: n('lineId'), roleId: Number(b.roleId) || null,
      roleName: str(b.roleName, 80), date: str(b.date, 10), title: str(b.title, 160),
      employeeId: n('employeeId'), employeeName: str(b.employeeName, 120), state: str(b.state, 8),
      replaceAssignmentId: Number(b.replaceAssignmentId) > 0 ? Number(b.replaceAssignmentId) : null,
      prevName: str(b.prevName, 120),
      updateAssignmentId: Number(b.updateAssignmentId) > 0 ? Number(b.updateAssignmentId) : null,
      expenseId: Number(b.expenseId) > 0 ? Number(b.expenseId) : null,
      logistics: str(b.logistics, 200) || null,
      additionalIds: (Array.isArray(b.additionalIds) ? b.additionalIds : []).map(Number).filter(Number.isInteger).slice(0, 20),
      additionalNames: (Array.isArray(b.additionalNames) ? b.additionalNames : []).map(x => str(x, 40)).slice(0, 20),
      by: user.name || user.email, at: new Date().toISOString(),
    });
    return { ok: true };
  }
  if (path === '/api/draft/delete' && req.method === 'POST') {
    need('board', 'editor');
    const { keys, all } = await body(req);
    await sessionStub(env).draftDelete(all === true ? '*' : (Array.isArray(keys) ? keys.map(String).slice(0, 500) : []));
    return { ok: true };
  }

  // «Отправить назначение»: BMS уведомляет сотрудника, статус назначения становится «ждёт ответа»
  if (path === '/api/notify' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 30);
    if (!ids.length) throw new HttpError(400, 'Нет назначений для отправки');
    const sent = [], failed = [];
    for (const id of ids) {
      try { await client.postRaw(`notifications/assignments/technical/${id}/notify`, id); sent.push(id); }
      catch (e) { failed.push({ id, error: String(e.message).slice(0, 200) }); }
    }
    console.log(JSON.stringify({ evt: 'notify', by: user.email, sent, failed: failed.length }));
    if (sent.length) { await sessionStub(env).bumpBoard(); clearCache(); }
    return { sent, failed };
  }

  if (path === '/api/assign' && req.method === 'POST') {
    need('board', 'editor');
    const b = await body(req);
    const ids = ['eventServiceId', 'lineId', 'employeeId'].map(k => Number(b[k]));
    if (ids.some(n => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'Некорректные идентификаторы');
    const replaceId = Number(b.replaceAssignmentId) > 0 ? Number(b.replaceAssignmentId) : null;
    const isVr = String(b.lineName || '').trim() === VR_LINE_NAME;
    const stub = sessionStub(env);
    const updateId = Number(b.updateAssignmentId) > 0 ? Number(b.updateAssignmentId) : null;
    if (updateId) {
      // тот же человек, меняются только допуслуги — правим назначение на месте
      const res = await updateAssignment(client, {
        assignmentId: updateId, eventServiceId: ids[0], lineId: ids[1], employeeId: ids[2],
        additionalIds: Array.isArray(b.additionalIds) ? b.additionalIds.slice(0, 20) : [],
        logistics: b.logistics ? String(b.logistics).slice(0, 200) : null,
        expenseId: Number(b.expenseId) > 0 ? Number(b.expenseId) : null,
      });
      console.log(JSON.stringify({ evt: 'updateAssignment', by: user.email, ...b, rate: res.rate }));
      await stub.draftDelete([`${ids[0]}:${ids[1]}`]);
      await stub.bumpBoard(); clearCache();
      return res;
    }
    try {
      if (replaceId) {
        // замена: сначала снимаем прежнего. Если BMS откажет — ничего не меняется.
        try { await client.delete(`projects/assignment/technical/${replaceId}`); }
        catch (e) { throw new HttpError(409, 'Не удалось снять прежнего исполнителя в BMS: ' + String(e.message).slice(0, 200)); }
      }
      let res;
      try {
        res = await assignEmployee(client, {
          eventServiceId: ids[0], lineId: ids[1], employeeId: ids[2], isVr,
          additionalIds: Array.isArray(b.additionalIds) ? b.additionalIds.slice(0, 20) : [],
        });
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
    need('rates'); checkRange(from, to);
    return { missing: findMissingRates(await fetchAssignments(client, from, to)) };
  }

  if (path === '/api/rates/fix' && req.method === 'POST') {
    need('rates', 'editor');
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

/** Читает лист-источник через Apps Script и обновляет матчи студий. */
export async function syncStudios(env, by) {
  const st = sessionStub(env);
  const src = await st.studiosSrcGet();
  if (!src) throw new HttpError(400, 'Источник не подключён: Админ → «Студии»');
  const d = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${src.url}?key=${encodeURIComponent(src.key)}&from=${d}`, { redirect: 'follow' });
  if (!res.ok) throw new HttpError(502, 'Источник ответил ' + res.status);
  let data;
  try { data = await res.json(); } catch { throw new HttpError(502, 'Источник вернул не JSON (проверьте доступ веб-приложения)'); }
  if (data.error) throw new HttpError(502, 'Источник: ' + data.error);
  const matches = (data.rows || []).map(parseSourceRow).filter(Boolean);
  const res2 = await st.studiosSyncApply(matches, d, by);
  return { ...res2, skipped: Array.isArray(data.skipped) ? data.skipped.slice(0, 10) : [] };
}

/** Читает историю матчей из таблицы студий (тот же Apps Script, mode=history) и пересчитывает статистику ВР. */
export async function syncVrHistory(env) {
  const st = sessionStub(env);
  const src = await st.studiosSrcGet();
  if (!src) throw new HttpError(400, 'Источник не подключён: Админ → «Студии: источник матчей»');
  const res = await fetch(`${src.url}?key=${encodeURIComponent(src.key)}&mode=history`, { redirect: 'follow' });
  if (!res.ok) throw new HttpError(502, 'Источник ответил ' + res.status);
  let data;
  try { data = await res.json(); } catch { throw new HttpError(502, 'Источник вернул не JSON'); }
  if (data.error) throw new HttpError(502, 'Источник: ' + data.error);
  if (!Array.isArray(data.history)) throw new HttpError(502, 'Скрипт источника устарел: обновите его (в нём нет режима history) и заново разверните');
  const stats = buildVrStats(data.history);
  await st.vrStatsSet(stats);
  return { rows: data.history.length, vrs: Object.keys(stats).length };
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    try {
      return json(await route(req, env, url, ctx), 200, cors);
    } catch (e) {
      if (e instanceof FhmError) return json({ error: e.message }, e.status === 429 ? 429 : 502, cors);
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status, cors);
      const msg = String(e && e.message || e);
      if (msg.includes(LOGIN_REQUIRED)) {
        return json({ error: 'Сессия BMS не активна. Администратор должен войти в BMS (раздел «Настройки»).', code: 'bms_login' }, 503, cors);
      }
      console.error(msg);
      return json({ error: 'Ошибка BMS: ' + msg.slice(0, 300) }, 502, cors);
    }
  },

  // раз в 5 минут держим «тёплыми» снимки текущего и следующего месяца — первый заход не ждёт BMS
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {   // история ВР — раз в сутки
      const v = await sessionStub(env).vrGet();
      if (!v.at || Date.now() - Date.parse(v.at) > 20 * 3600 * 1000) await syncVrHistory(env);
    })().catch(e => { if (!/не подключ/.test(String(e.message))) console.error('vrhistory', String(e.message || e)); }));
    ctx.waitUntil(syncStudios(env, 'авто').catch(e => { if (!/не подключ/.test(String(e.message))) console.error('studios', String(e.message || e)); }));
    const client = makeClient(env);
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      const y = now.getUTCFullYear(), m = now.getUTCMonth() + i;
      const d = new Date(Date.UTC(y, m, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const from = `${ym}-01`, to = `${ym}-${String(last).padStart(2, '0')}`;
      ctx.waitUntil(buildFresh(env, client, `board|${from}|${to}|false`, from, to, false).catch(e => console.error('cron', String(e))));
    }
  },
};
