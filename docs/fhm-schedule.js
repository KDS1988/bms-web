(function (root) {
  'use strict';

  function buildSchedule(matches, { from, to }) {
    const dates = [];
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86400000) {
      dates.push(new Date(day).toISOString().slice(0, 10));
    }

    const arenas = new Map(), totals = new Map();
    for (const match of matches) {
      if (match.date < from || match.date > to || ['cancelled', 'postponed'].includes(match.status)) continue;
      const key = (match.venueId ?? match.venue) + (match.copy ? ':2' : '');
      if (!arenas.has(key)) arenas.set(key, { key, name: match.venue, location: '', count: 0, days: new Map() });
      const arena = arenas.get(key);
      arena.location ||= match.location;
      if (!arena.days.has(match.date)) arena.days.set(match.date, { count: 0, start: '' });
      const day = arena.days.get(match.date);
      day.count++;
      arena.count++;
      if (match.time && (!day.start || match.time < day.start)) day.start = match.time;

      if (!totals.has(match.date)) totals.set(match.date, { matches: 0, crews: 0 });
      const total = totals.get(match.date);
      total.matches++;
      if (day.count === 1) total.crews++;
    }
    const rows = [...arenas.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return { dates, rows, totals };
  }

  const api = { buildSchedule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FhmSchedule = api;
})(globalThis);
