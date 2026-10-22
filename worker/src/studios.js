/**
 * Вкладка «СТУДИИ»: рестримы из таблицы-источника (лист «ВНОСИТЬ СЮДА!!!»),
 * те же столбцы, что в таблице студий.
 * Строка источника приходит из Apps Script уже разобранной (см. apps-script/studios-export.gs).
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{1,2}:\d{2}$/;

export const STATUSES = ['', 'запланировано', 'выполнено', 'отмена', 'проблемы в студии', 'проблемы на площадке'];
/** Поля, которые правятся на доске (после правки синхронизация их не затирает). */
export const EDITABLE = ['bmsId', 'studio', 'pc', 'date', 'start', 'end', 'project', 't1', 't2', 'vr', 'comm', 'status', 'support', 'engineer', 'tri', 'comment', 'scomment', 'parallel'];

export const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
export const fmtTime = t => { const n = toMin(t); return n == null ? '' : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };

const str = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** Строка из Apps Script → матч. null — строка не годится (нет даты/времени). */
export function parseSourceRow(r) {
  const date = str(r.date, 10);
  const start = fmtTime(str(r.start, 8)), end = fmtTime(str(r.end, 8));
  if (!ISO.test(date) || !start || !end) return null;
  const vrName = str(r.vr);
  const comm = [str(r.comm1), str(r.comm2)].filter(x => x && x !== '-').join(', ');
  return {
    studio: str(r.studio, 40), pc: str(r.pc, 20), date, start, end, evStart: fmtTime(str(r.evStart, 8)),
    project: str(r.project, 120), t1: str(r.t1, 160), t2: str(r.t2, 160),
    cabin: ['да', 'нет'].includes(str(r.cabin, 10).toLowerCase()) ? str(r.cabin, 10).toLowerCase() : '',
    vr: vrName === '-' ? '' : vrName, comm, status: '', support: '', engineer: '', tri: '', comment: '', scomment: '',
  };
}

export function matchKey(m) { return [m.date, m.start, m.end, m.project, m.t1, m.t2].join('|'); }

/** Ручная правка/добавление: оставляем только известные поля. */
export function sanitizePatch(b, full) {
  const out = {};
  const put = (k, max) => { if (b[k] !== undefined) out[k] = str(b[k], max); };
  put('studio', 40); put('pc', 20); put('project', 120); put('t1', 160); put('t2', 160); put('vr', 80); put('comm', 160);
  put('support', 80); put('engineer', 80); put('tri', 80); put('comment', 300); put('scomment', 300);
  if (b.parallel !== undefined) out.parallel = b.parallel === true;
  if (b.bmsId !== undefined) {   // ID услуги мероприятия в BMS (по нему строится ссылка и назначения)
    if (b.bmsId === '' || b.bmsId === null) out.bmsId = null;
    else { const n = Number(b.bmsId); if (!Number.isInteger(n) || n <= 0) return { error: 'ID BMS — целое число' }; out.bmsId = n; }
  }
  if (b.status !== undefined) { out.status = str(b.status, 40); if (!STATUSES.includes(out.status)) return { error: 'Неизвестный статус' }; }
  if (b.date !== undefined) { out.date = str(b.date, 10); if (!ISO.test(out.date)) return { error: 'Некорректная дата' }; }
  for (const k of ['start', 'end']) if (b[k] !== undefined) { out[k] = fmtTime(str(b[k], 8)); if (!out[k]) return { error: 'Время в формате ЧЧ:ММ' }; }
  if (full && (!out.date || !out.start || !out.end)) return { error: 'Нужны дата, начало и конец' };
  return { patch: out };
}

/**
 * Слияние: existing — матчи одной даты, incoming — свежие из источника.
 * Возвращает новый список. Ручные правки (ov) и ручные матчи (manual) не трогаем.
 */
export function mergeDay(existing, incoming) {
  const byKey = new Map();
  for (const e of existing) if (!e.manual) { const k = e.k; (byKey.get(k) || byKey.set(k, []).get(k)).push(e); }
  const seen = new Map();
  const out = existing.filter(e => e.manual);
  for (const inc of incoming) {
    const k = matchKey(inc);
    const n = seen.get(k) || 0; seen.set(k, n + 1);
    const cand = (byKey.get(k) || [])[n];
    if (cand) {
      const ov = cand.ov || {};
      const next = { ...cand };
      for (const f of Object.keys(inc)) if (!ov[f]) next[f] = inc[f];
      out.push(next);
    } else {
      out.push({ ...inc, id: 's' + hash(k + '#' + n), k, ov: {} });
    }
  }
  // источник матч убрал, но человек уже что-то правил — оставляем
  for (const e of existing) {
    if (e.manual) continue;
    const k = e.k, n = (byKey.get(k) || []).indexOf(e);
    if (n >= (seen.get(k) || 0) && e.ov && Object.keys(e.ov).length) out.push(e);
  }
  return out.sort((a, b) => toMin(a.start) - toMin(b.start) || a.id.localeCompare(b.id));
}

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---- история ВР: статистика по выполненным матчам из таблицы студий
export const VR_LABELS = ['', 'новичок', 'опытный', 'нестабильный'];
const normName = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** rows: [дата, студия, проект, ВР, статус, начало, конец]. Возвращает { имя: { n, bad, first, last, proj } }. */
export function buildVrStats(rows) {
  const out = {};
  for (const r of rows) {
    const [date, , project, vrRaw, status] = r;
    const vr = normName(vrRaw);
    if (!vr || vr === '-' || !ISO.test(String(date))) continue;
    const done = status === 'выполнено', bad = status === 'проблемы в студии' || status === 'проблемы на площадке';
    if (!done && !bad) continue;
    const e = out[vr] || (out[vr] = { n: 0, bad: 0, first: date, last: date, proj: {} });
    if (done) e.n++; else e.bad++;
    if (date < e.first) e.first = date;
    if (date > e.last) e.last = date;
    const p = normName(project);
    if (p) e.proj[p] = (e.proj[p] || 0) + 1;
  }
  for (const e of Object.values(out)) {   // оставляем самые частые проекты — хранилище не резиновое
    const top = Object.entries(e.proj).sort((a, b) => b[1] - a[1]).slice(0, 15);
    e.proj = Object.fromEntries(top);
  }
  return out;
}

/** Метка по истории. today — ГГГГ-ММ-ДД. Порог «новичка»: меньше 20 матчей или первый матч меньше 45 дней назад. */
export function autoLabel(e, today) {
  const days = (new Date(today) - new Date(e.first)) / 86400000;
  if (e.n < 20 || days < 45) return 'новичок';
  const total = e.n + e.bad;
  if (e.bad >= 3 && e.bad / total >= 0.1) return 'нестабильный';
  return 'опытный';
}
