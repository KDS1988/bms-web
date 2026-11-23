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
      if (!arenas.has(key)) arenas.set(key, {
        key, name: match.venue, location: '', editable: match.venueId != null, count: 0, days: new Map(),
      });
      const arena = arenas.get(key);
      arena.location ||= match.location;
      if (!arena.days.has(match.date)) arena.days.set(match.date, { count: 0, start: '', finish: null });
      const day = arena.days.get(match.date);
      day.count++;
      arena.count++;
      if (match.time) {
        if (!day.start || match.time < day.start) day.start = match.time;
        const [hour, minute] = match.time.split(':').map(Number);
        const finish = hour * 60 + minute + (match.duration ?? 135);
        day.finish = Math.max(day.finish ?? 0, finish);
      }

      if (!totals.has(match.date)) totals.set(match.date, { matches: 0, crews: 0 });
      const total = totals.get(match.date);
      total.matches++;
      if (day.count === 1) total.crews++;
    }
    const rows = [...arenas.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return { dates, rows, totals };
  }

  function endTime(finish) {
    if (finish == null) return '';
    const clock = finish % 1440;
    return [Math.floor(clock / 60), clock % 60].map(n => String(n).padStart(2, '0')).join(':');
  }

  const CREW_FIELDS = [['director', 'Реж'], ['operator', 'Опер'], ['stat', 'Стат'], ['commentator', 'Коммент']];

  function crewComplete(crew) {
    return CREW_FIELDS.every(([field]) => !!crew?.[field]?.trim());
  }

  function arrangeRows(rows, crews, { day, mode, sort }) {
    const visible = rows.filter(row => !day || mode === 'all' ||
      (row.days.has(day) && (mode === 'matches' || !crewComplete(crews[day]?.[row.key]))));
    const value = row => {
      if (!sort.date) return row[sort.field];
      const item = row.days.get(sort.date);
      if (sort.field === 'count') return item?.count || 0;
      if (sort.field === 'start' || sort.field === 'finish') return item?.[sort.field];
      return crews[sort.date]?.[row.key]?.[sort.field];
    };
    const byName = (a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true });
    return visible.sort((a, b) => {
      const av = value(a), bv = value(b);
      const aMissing = av == null || av === '', bMissing = bv == null || bv === '';
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return byName(a, b);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv : String(av).localeCompare(String(bv), 'ru', { numeric: true });
      return sort.direction * cmp || byName(a, b);
    });
  }

  const api = { buildSchedule, endTime, CREW_FIELDS, crewComplete, arrangeRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FhmSchedule = api;
})(globalThis);
