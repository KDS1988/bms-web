const MATCHES_URL = 'https://api.fhmoscow.com/api/integrations/broadcast/v1/matches';
const MAX_PAGES = 40;

export class FhmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchPage(key, from, to, { limit, cursor, signal }) {
  const url = new URL(MATCHES_URL);
  url.search = new URLSearchParams({ dateFrom: from, dateTo: to, limit: String(limit) });
  if (cursor) url.searchParams.set('cursor', cursor);

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': key },
      redirect: 'manual', signal,
    });
  } catch {
    throw new FhmError('API ФХМ не ответил. Попробуйте обновить календарь позже.');
  }
  if (response.status >= 300 && response.status < 400) throw new FhmError('API ФХМ перенаправил запрос.', response.status);
  if (response.status === 401 || response.status === 403) {
    throw new FhmError('ФХМ не приняла ключ или не разрешила доступ к календарю.', response.status);
  }
  if (response.status === 429) throw new FhmError('Достигнут лимит запросов ФХМ. Попробуйте позже.', 429);
  if (!response.ok) throw new FhmError('API ФХМ вернул ошибку. Попробуйте позже.', response.status);

  const page = await response.json().catch(() => null);
  const next = page?.meta?.nextCursor;
  if (!Array.isArray(page?.data) || (next !== null && (typeof next !== 'string' || !next))) {
    throw new FhmError('ФХМ вернула ответ в неожиданном формате.');
  }
  return page;
}

export async function verifyFhmKey(key) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format();
  await fetchPage(key, today, today, { limit: 1, signal: AbortSignal.timeout(8000) });
}

export async function loadFhmCalendar(key, from, to) {
  const matches = new Map();
  const seen = new Set();
  const signal = AbortSignal.timeout(25000);
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(key, from, to, { limit: 100, cursor, signal });
    for (const match of result.data) {
      const date = match.startsAt?.slice(0, 10) || '';
      const homeYear = match.homeTeam?.year, awayYear = match.awayTeam?.year;
      const year = homeYear && awayYear && homeYear !== awayYear ? null : (homeYear || awayYear || null);
      const venue = match.venue?.name || '';
      const group = match.group?.name || '';
      const groupA = /^(?:группа\s+)?[аa]$/iu.test(group.replace(/[«»“”"]/g, '').trim());
      const short = year === 2017 || (year === 2016 && group && !groupA);
      const row = {
        duration: short ? 105 : 135,
        id: match.id, date, time: match.startsAt?.slice(11, 16) || '', year,
        home: match.homeTeam?.fullName || '', away: match.awayTeam?.fullName || '',
        group, tour: match.tour?.name || '', venue,
        venueId: match.venue?.id || null, location: match.venue?.address || '', status: match.status,
      };
      matches.set(match.id, row);
    }
    cursor = result.meta.nextCursor;
    if (cursor === null) {
      const order = match => match.date ? match.date + match.time : '9999';
      const rows = [...matches.values()].sort((a, b) => order(a).localeCompare(order(b)));
      return { matches: rows.flatMap(row => row.venue && row.duration === 105
        ? [row, { ...row, venue: row.venue + '_2', copy: true }]
        : [row]) };
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new FhmError('ФХМ не вернула полный календарь за этот период.');
}

export function parseFhmCrewEdit(data) {
  const { date, arena, field } = data || {};
  if (typeof date !== 'string' || typeof arena !== 'string' || !/^[1-9]\d{0,14}(?::2)?$/.test(arena) ||
      !['director', 'operator', 'stat', 'commentator'].includes(field) || typeof data.value !== 'string') return null;
  const value = data.value.trim().replace(/\s+/g, ' ');
  return value.length <= 80 ? { date, arena, field, value } : null;
}
