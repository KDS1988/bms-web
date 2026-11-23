import test from 'node:test';
import assert from 'node:assert/strict';
import { FhmError, calendarTeamName, calendarVenueAddress, loadFhmCalendar, matchFhmBmsIds, parseFhmCrewEdit, verifyFhmKey, withCalendarAddresses } from '../src/fhm.js';

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


test('ДХ: берёт опубликованный адрес совпадающей арены и заполняет строку _2', async () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","location":{"address":"Чужой адрес"}}</script>
    <script type="application/ld+json">{"@type":"SportsEvent","location":{"name":"Арена","address":{"addressLocality":"Москва","streetAddress":"Ледовая ул., 12"}}}</script>`;
  assert.equal(calendarVenueAddress(html, 'Арена'), 'Москва, Ледовая ул., 12');
  assert.equal(calendarVenueAddress(html, 'Другая арена'), '');
  const one = { id: 10, venueId: 3, venue: 'Арена', date: from, location: '' };
  const { matches } = await withCalendarAddresses({ matches: [
    one, { ...one, venue: 'Арена_2', copy: true }, { ...one, venueId: 2, location: 'Тверь' },
  ] }, async venues => {
    assert.deepEqual(venues, [{ venueId: 3, matchId: 10, arena: 'Арена' }]);
    return { 3: calendarVenueAddress(html, 'Арена') };
  });
  assert.deepEqual(matches.map(row => row.location), ['Москва, Ледовая ул., 12', 'Москва, Ледовая ул., 12', 'Тверь']);
});


test('календарь ДХ: удаляет только год рождения на конце названия команды', () => {
  assert.equal(calendarTeamName({ fullName: 'Локомотив-2004 2009', year: 2009 }), 'Локомотив-2004');
  assert.equal(calendarTeamName({ fullName: 'Локомотив 2004', year: 2004 }), 'Локомотив 2004');
  assert.equal(calendarTeamName({ fullName: 'Спартак 2017 г.р.', year: 2017 }), 'Спартак');
  assert.equal(calendarTeamName({ fullName: 'Динамо (2017)', year: 2017 }), 'Динамо');
  assert.equal(calendarTeamName({ fullName: 'Клуб 1998', year: 1998, club: { fullName: 'Клуб 1998' } }), 'Клуб 1998');
  assert.equal(calendarTeamName({ fullName: 'Клуб 2010', year: 2015 }), 'Клуб 2010');
});

test('календарь ДХ: связывает с ID мероприятия БМС по дате, времени и обеим командам', () => {
  const row = { id: 1, date: from, time: '09:30', home: 'Локомотив-2004', away: 'Динамо', homeYear: 2009, awayYear: 2009 };
  const event = {
    id: 406, date: from, start_time: '9:30:00', league: { short_name: 'ФХМ' },
    home_team: { name: 'Локомотив - 2004 2009' }, away_team: { name: 'Динамо 2009' },
  };
  assert.deepEqual(matchFhmBmsIds([row, { ...row, copy: true }], [
    { id: 98, event }, { id: 99, event }, { event: { ...event, id: 407, date: to } },
    { event: { ...event, id: 408, start_time: '09:35:00' } },
    { event: { ...event, id: 409, away_team: { name: 'Динамо 2016' } } },
    { event: { ...event, id: 410, league: { short_name: 'КХЛ' } } },
  ]), { 1: 406 });
  assert.deepEqual(matchFhmBmsIds([row], [{ event }, { event: { ...event, id: 111 } }]), {});
  assert.deepEqual(matchFhmBmsIds([row, { ...row, id: 2 }], [{ event }]), {});
});
