import { FHM_PUBLISHED_LOCATIONS } from './fhm-locations.js';

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

const teamKey = name => String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');

export function calendarTeamName(team) {
  const name = String(team?.fullName || team?.shortName || '').trim();
  const year = Number(team?.year);
  const key = teamKey(name);
  if (!Number.isInteger(year) || year < 1900 || year > 2200 ||
      key === 'локомотив2004' || [team?.club?.fullName, team?.club?.shortName].some(club => name && key === teamKey(club))) return name;
  return name.replace(new RegExp(`\\s+(?:\\(${year}\\)|${year}(?:\\s*г\\.?\\s*р\\.?)?)$`, 'iu'), '').trimEnd();
}

function isFhmLeague(league) {
  return [league?.short_name, league?.name, league?.full_name].some(name =>
    /(?:^|[^а-яё])фхм(?:$|[^а-яё])|федерация хоккея москвы/iu.test(String(name || '')));
}

export function matchFhmBmsIds(rows, assignmentItems) {
  const byKickoff = new Map();
  for (const item of assignmentItems) {
    const event = item?.event;
    const id = Number(event?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !isFhmLeague(event.league)) continue;
    const explicit = [event.home_team?.name, event.away_team?.name];
    const teams = explicit.every(Boolean) ? explicit
      : String(event.additional_info || event.event_description || '').trim().split(/\s+[-–—]\s+/);
    const time = /^(\d{1,2}):(\d{2})(?::|$)/.exec(event.start_time || '');
    const [home, away] = teams;
    if (teams.length !== 2 || !home || !away || !event.date || !time) continue;
    const slot = `${event.date}T${time[1].padStart(2, '0')}:${time[2]}`;
    if (!byKickoff.has(slot)) byKickoff.set(slot, new Map());
    byKickoff.get(slot).set(id, { home, away });
  }
  const candidates = new Map(), uses = new Map();
  const sameTeam = (label, birthYear, bmsLabel) => {
    const key = teamKey(label);
    return key && (key === teamKey(bmsLabel) || key === teamKey(calendarTeamName({ fullName: bmsLabel, year: birthYear })));
  };
  for (const row of rows) {
    if (row.copy || !row.date || !row.time) continue;
    const events = byKickoff.get(row.date + 'T' + row.time);
    if (!events) continue;
    const ids = [...events].filter(([, event]) =>
      sameTeam(row.home, row.homeYear, event.home) && sameTeam(row.away, row.awayYear, event.away)).map(([id]) => id);
    if (ids.length) candidates.set(row.id, ids);
    for (const id of ids) uses.set(id, (uses.get(id) || 0) + 1);
  }
  return Object.fromEntries([...candidates].flatMap(([id, matches]) =>
    matches.length === 1 && uses.get(matches[0]) === 1 ? [[id, matches[0]]] : []));
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
        home: calendarTeamName(match.homeTeam), away: calendarTeamName(match.awayTeam),
        homeYear: homeYear || null, awayYear: awayYear || null,
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

const venueName = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');

function placeAddress(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return [value.postalCode, value.addressRegion, value.addressLocality, value.streetAddress]
    .filter(part => typeof part === 'string' && part.trim()).map(part => part.trim()).join(', ');
}

export function calendarVenueAddress(html, arena) {
  const expected = venueName(arena);
  for (const block of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const event = JSON.parse(block[1]);
      if (event['@type'] === 'SportsEvent' && expected && venueName(event.location?.name) === expected) {
        return placeAddress(event.location.address).slice(0, 300);
      }
    } catch { /* На странице есть другие блоки JSON-LD. */ }
  }
  return '';
}

export async function fetchCalendarVenueAddress({ matchId, arena }) {
  if (!/^[1-9]\d{0,14}$/.test(String(matchId))) return '';
  try {
    const response = await fetch('https://fhmoscow.com/game/' + matchId, {
      redirect: 'manual', signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return calendarVenueAddress(await response.text(), arena);
  } catch {
    return null;
  }
}

export async function withCalendarAddresses(calendar, getAddresses) {
  const venues = new Map(), addresses = {};
  for (const row of calendar.matches) {
    if (!row.venueId) continue;
    if (row.location) addresses[row.venueId] = row.location;
    else if (!row.copy && row.date && row.status !== 'cancelled' && !addresses[row.venueId]) {
      const known = FHM_PUBLISHED_LOCATIONS[row.venueId];
      if (known && venueName(known[0]) === venueName(row.venue)) addresses[row.venueId] = known[1];
      else venues.set(row.venueId, { venueId: row.venueId, matchId: row.id, arena: row.venue });
    }
  }
  const missing = [...venues.values()].filter(entry => !addresses[entry.venueId]);
  const batches = [];
  for (let i = 0; i < missing.length; i += 18) batches.push(missing.slice(i, i + 18));
  for (let i = 0; i < batches.length; i += 2) {
    await Promise.all(batches.slice(i, i + 2).map(async batch => {
      try { Object.assign(addresses, await getAddresses(batch)); }
      catch { /* Календарь остаётся доступен при недоступности страниц матчей. */ }
    }));
  }
  return { matches: calendar.matches.map(row => ({
    ...row, location: row.location || addresses[row.venueId] || '',
  })) };
}
