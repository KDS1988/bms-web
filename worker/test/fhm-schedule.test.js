import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildSchedule, endTime } = createRequire(import.meta.url)('../../docs/fhm-schedule.js');

test('ДХ: расписание агрегирует календарь по аренам и дням, включая пустые даты месяца', () => {
  const match = { date: '2026-11-01', time: '12:00', venue: 'Арена', venueId: 5, location: 'Москва', status: 'scheduled' };
  const { dates, rows, totals } = buildSchedule([
    match, { ...match, time: '10:00' }, { ...match, copy: true, venue: 'Арена_2' },
    { ...match, date: '2026-11-02', status: 'cancelled' }, { ...match, date: '', time: '' },
  ], { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(dates.length, 30);
  assert.deepEqual(rows.map(row => [row.name, row.count, row.days.get(match.date).start]),
    [['Арена', 2, '10:00'], ['Арена_2', 1, '12:00']]);
  assert.deepEqual(totals.get(match.date), { matches: 3, crews: 2 });
  assert.equal(totals.has('2026-11-02'), false);
});


test('ДХ: интервал арены покрывает матчи разной длительности и учитывает переход через полночь', () => {
  const date = '2026-11-01';
  const match = { date, time: '20:00', duration: 135, venue: 'Арена', venueId: 5, status: 'scheduled' };
  const { rows } = buildSchedule([
    match, { ...match, time: '15:00', duration: 105 }, { ...match, time: '22:30', duration: 105 },
  ], { from: date, to: date });
  const day = rows[0].days.get(date);
  assert.equal(day.start, '15:00');
  assert.equal(day.finish, 1455);
  assert.equal(endTime(day.finish), '00:15');
  assert.equal(endTime(null), '');
});
