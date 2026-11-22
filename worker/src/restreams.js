import { eventTitle } from './board.js';

export const RECIPIENTS = [
  ['input', 'Входящий поток'],
  ['srt', 'Исходящий SRT'],
  ['rtmp', 'Исходящий RTMP'],
  ['tricolor', 'Триколор'],
  ['inventos', 'Инвентос'],
  ['league', 'Соцсети лиги'],
  ['regional', 'Рег. ТВ'],
  ['sl', 'SL'],
  ['regional2', 'Рег. ТВ 2'],
  ['club', 'Соцсети клуба'],
  ['kp', 'КП'],
].map(([id, label]) => ({ id, label }));

const RECIPIENT_IDS = new Set(RECIPIENTS.map(r => r.id));
const FIELDS = ['protocol', 'address', 'port', 'key', 'passphrase', 'login', 'password', 'link'];
const MATCH_FIELDS = ['eventId', 'league', 'home', 'studio'];
const TEMPLATE_FIELDS = ['eventId', 'eventServiceId', 'date', 'ddmmyyyy', 'league', 'home', 'away', 'studio', 'pc', 'slKey', 'pass', 'leagueCode'];
const text = value => ['string', 'number'].includes(typeof value) ? String(value).trim() : '';
const streamValue = value => {
  const s = text(value);
  return /^(?:[-–—]$|#|выберите|проставьте)/i.test(s) ? '' : s;
};
const normalize = value => text(value).toLowerCase().replace(/ё/g, 'е');
const id = value => /^[1-9]\d{0,14}$/.test(text(value)) ? Number(value) : null;
const pick = (value, keys, read = text) => Object.fromEntries(keys.flatMap(k => {
  const v = read(value?.[k]);
  return v ? [[k, v]] : [];
}));

export function restreamEvents(items, from, to) {
  const rows = new Map();
  for (const item of items) {
    const ev = item?.event;
    const eventServiceId = id(item?.id);
    const eventId = id(ev?.id);
    if (!eventServiceId || !eventId || normalize(item?.service?.name) !== 'ретрансляция' || !ev.date || ev.date < from || ev.date > to) continue;
    rows.set(eventServiceId, {
      eventServiceId, eventId, date: ev.date, title: eventTitle(ev), start: text(ev.start_time).slice(0, 5),
      end: text(ev.end_time).slice(0, 5), league: text(ev.league?.short_name || ev.league?.name),
      home: text(ev.home_team?.name), away: text(ev.away_team?.name), city: text(ev.city || ev.location?.city),
      info: [...new Set([text(ev.additional_info), text(ev.event_description)])].filter(Boolean).join(' · '),
      cancelled: /^отмен/i.test(text(item.service_status)), status: text(item.service_status),
    });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.eventServiceId - b.eventServiceId);
}

export function parseRestreamRules(rules) {
  if (!Array.isArray(rules) || rules.length > 150) return null;
  const out = [];
  for (const rule of rules) {
    if (!rule || !RECIPIENT_IDS.has(rule.recipient) || !rule.match || !rule.params ||
        Object.keys(rule.match).some(k => !MATCH_FIELDS.includes(k)) ||
        Object.keys(rule.params).some(k => !FIELDS.includes(k))) return null;
    const match = pick(rule.match, MATCH_FIELDS);
    const params = pick(rule.params, FIELDS);
    if (!params.protocol || !params.address || Object.keys(match).length !== Object.keys(rule.match).length) return null;
    if (Object.values(params).some(value => value.length > 512 ||
        [...value.matchAll(/\{([^{}]+)\}/g)].some(([, field]) => !TEMPLATE_FIELDS.includes(field)) ||
        /[{}]/.test(value.replace(/\{[^{}]+\}/g, '')))) return null;
    out.push({ recipient: rule.recipient, match, params });
  }
  return JSON.stringify(out).length <= 24000 ? out : null;
}

export function getRestreamDecision(data) {
  const eventServiceId = id(data?.eventServiceId);
  const { recipient, needed } = data || {};
  if (!eventServiceId || !RECIPIENT_IDS.has(recipient) || typeof needed !== 'boolean') return null;
  return { eventServiceId, recipient, needed };
}

function uniqueRows(rows) {
  const byId = new Map();
  const ambiguous = new Set();
  for (const row of rows) {
    const eventId = id(row?.eventId);
    if (!eventId || ambiguous.has(eventId)) continue;
    if (byId.has(eventId)) {
      if (JSON.stringify(byId.get(eventId)) !== JSON.stringify(row)) {
        byId.delete(eventId);
        ambiguous.add(eventId);
      }
    } else {
      byId.set(eventId, row);
    }
  }
  return { byId, ambiguous };
}

export function restreamSources(data = {}) {
  return { sheet: uniqueRows(data.rows || []), server: uniqueRows(data.srt || []) };
}

function expand(params, values) {
  return Object.fromEntries(Object.entries(params).flatMap(([k, template]) => {
    let missing = false;
    const value = template.replace(/\{([^{}]+)\}/g, (_, field) => {
      const v = streamValue(values[field]);
      if (!v) missing = true;
      return v;
    });
    return missing ? [] : [[k, value]];
  }));
}

export function missingStreamFields(params) {
  const missing = [];
  const protocol = normalize(params.protocol);
  if (!protocol) missing.push('protocol');
  if (!params.address) missing.push('address');
  if (protocol.includes('rtmp') && !params.key) missing.push('key');
  if (protocol.includes('srt')) {
    const port = params.port || /^srt:\/\/(?:\[[^\]]+\]|[^:/?#]+):(\d+)(?:[/#?]|$)/i.exec(params.address || '')?.[1];
    if (!(Number.isInteger(Number(port)) && +port > 0 && +port <= 65535)) missing.push('port');
  }
  return missing;
}

export function restreamRow(event, decisions, sources, rules) {
  const legacy = sources.sheet.byId.get(event.eventId);
  const server = sources.server.byId.get(event.eventId);
  const setup = pick(legacy?.setup, ['studio', 'pc', 'format', 'airStart', 'airEnd', 'round', 'production', 'brief', 'manager', 'vr', 'graphics', 'cabin', 'commentator1', 'commentator2']);
  const values = {
    ...event, ...setup, ...pick(legacy?.setup, ['slKey', 'pass', 'leagueCode']),
    ddmmyyyy: event.date.split('-').reverse().join(''),
  };
  const matches = rules.filter(rule => Object.entries(rule.match).every(([key, value]) => normalize(values[key]) === normalize(value)));
  return {
    ...event, setup,
    streams: Object.fromEntries(RECIPIENTS.map(({ id }) => {
      const sheet = legacy?.streams?.[id];
      const needed = decisions[id] ?? (typeof sheet?.needed === 'boolean' ? sheet.needed : null);
      if (needed !== true) return [id, { needed }];
      const candidates = [pick(sheet?.params, FIELDS, streamValue)];
      if (id === 'srt') candidates.push(pick(server?.params, FIELDS, streamValue));
      const rule = matches.find(r => r.recipient === id);
      if (rule) candidates.push(expand(rule.params, values));
      const params = candidates.find(candidate => !missingStreamFields(candidate).length) ||
        candidates.find(candidate => Object.keys(candidate).length) || {};
      const missing = missingStreamFields(params);
      if (rule && candidates.at(-1) === params) {
        for (const key of Object.keys(rule.params)) if (!params[key] && !missing.includes(key)) missing.push(key);
      }
      const ambiguous = sources.sheet.ambiguous.has(event.eventId) || (id === 'srt' && sources.server.ambiguous.has(event.eventId));
      return [id, { needed, params, missing, ambiguous: ambiguous && missing.length > 0 }];
    })),
  };
}
