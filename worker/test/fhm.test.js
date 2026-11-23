import test from 'node:test';
import assert from 'node:assert/strict';
import { FhmError, loadFhmCalendar, parseFhmCrewEdit, verifyFhmKey } from '../src/fhm.js';

const from = '2026-11-01', to = '2026-11-30';
const page = (data, nextCursor) => Response.json({ data, meta: { nextCursor } });
const match = (id, startsAt) => ({
  id, startsAt, homeTeam: { fullName: 'Север' }, awayTeam: { fullName: 'Юг' },
  venue: { name: 'Ледовый дворец' }, group: { name: 'Группа Б' }, tour: null, status: 'scheduled',
});

test('ФХМ: календарь читает все страницы и сортирует матчи по московским дате и времени', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async url => url.searchParams.has('cursor')
    ? page([match(2, '2026-11-10T09:20:00+03:00'), match(3, null)], null)
    : page([match(1, '2026-11-18T15:40:00+03:00')], 'opaque+/cursor'));
  const { matches } = await loadFhmCalendar('prefix.test', from, to);
  assert.deepEqual(matches.map(({ id, date, time }) => [id, date, time]), [
    [2, '2026-11-10', '09:20'], [1, '2026-11-18', '15:40'], [3, '', ''],
  ]);
  const [[url, options], [next]] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(url.pathname, '/api/integrations/broadcast/v1/matches');
  assert.equal(url.searchParams.get('dateFrom'), from);
  assert.equal(url.searchParams.get('dateTo'), to);
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(next.searchParams.get('cursor'), 'opaque+/cursor');
  assert.equal(options.headers['X-API-Key'], 'prefix.test');
  assert.equal(options.redirect, 'manual');
});

test('ФХМ: при зацикленном курсоре календарь сообщает об ошибке', async t => {
  t.mock.method(globalThis, 'fetch', async () => page([], 'repeated'));
  await assert.rejects(loadFhmCalendar('prefix.test', from, to), /не вернула полный календарь/);
});

test('ФХМ: ошибка доступа не раскрывает ключ или тело ответа', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('prefix.test', { status: 403 }));
  await assert.rejects(verifyFhmKey('prefix.test'), e =>
    e instanceof FhmError && e.status === 403 && !e.message.includes('prefix.test'));
});


test('ФХМ: перенаправление отклоняется, ключ не передаётся дальше', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.redirect('https://example.com/', 302));
  await assert.rejects(verifyFhmKey('prefix.test'), /перенаправил запрос/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('ФХМ: копии на арене _2 только для 2017 и для 2016 вне группы А', async t => {
  const row = (id, year, group) => ({
    ...match(id, '2026-11-03T11:00:00+03:00'),
    group: group && { name: group },
    homeTeam: { fullName: 'Север', year },
    awayTeam: { fullName: 'Юг', year },
    venue: { id: 321, name: 'Арена', address: 'Подольск' },
  });
  t.mock.method(globalThis, 'fetch', async () => page([
    row(1, 2017, 'Группа А'), row(2, 2016, 'Группа A'), row(3, 2016, 'Группа Б'),
    row(4, 2015, 'Группа Б'), row(5, 2016, null), row(6, 2016, 'Группа «А»'),
    { ...row(7, 2017, 'Группа А'), venue: null },
  ], null));
  const { matches } = await loadFhmCalendar('prefix.test', from, to);
  assert.deepEqual(matches.filter(row => row.copy).map(({ id, venue, venueId, location }) =>
    [id, venue, venueId, location]), [[1, 'Арена_2', 321, 'Подольск'], [3, 'Арена_2', 321, 'Подольск']]);
  assert.deepEqual(matches.filter(row => !row.copy).map(row => [row.id, row.duration]),
    [[1, 105], [2, 135], [3, 105], [4, 135], [5, 135], [6, 135], [7, 105]]);
});


test('ДХ: запись бригады проверяет идентификатор арены, поле и фамилию', () => {
  const edit = { date: '2026-11-01', arena: '321:2', field: 'director', value: '  Иванов   Петров  ' };
  assert.deepEqual(parseFhmCrewEdit(edit), { ...edit, value: 'Иванов Петров' });
  assert.equal(parseFhmCrewEdit({ ...edit, arena: '__proto__' }), null);
  assert.equal(parseFhmCrewEdit({ ...edit, field: 'start' }), null);
  assert.equal(parseFhmCrewEdit({ ...edit, value: 'x'.repeat(81) }), null);
  assert.equal(parseFhmCrewEdit({ ...edit, value: ' ' }).value, '');
});
