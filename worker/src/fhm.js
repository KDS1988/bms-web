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
      redirect: 'error', signal,
    });
  } catch {
    throw new FhmError('API ФХМ не ответил. Попробуйте обновить календарь позже.');
  }
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
      matches.set(match.id, {
        id: match.id, date, time: match.startsAt?.slice(11, 16) || '',
        home: match.homeTeam?.fullName || '', away: match.awayTeam?.fullName || '',
        group: match.group?.name || '', tour: match.tour?.name || '',
        venue: match.venue?.name || '', status: match.status,
      });
    }
    cursor = result.meta.nextCursor;
    if (cursor === null) {
      const order = match => match.date ? match.date + match.time : '9999';
      return { matches: [...matches.values()].sort((a, b) => order(a).localeCompare(order(b))) };
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new FhmError('ФХМ не вернула полный календарь за этот период.');
}
