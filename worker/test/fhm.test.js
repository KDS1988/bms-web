import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEvents } from '../src/bms.js';
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

test('календарь ДХ: берёт дату мероприятия и время, год и команды из описания БМС', () => {
  const row = { id: 23658, date: '2026-11-21', time: '09:30', year: 2016, home: 'Академия Михайлова (Москва)', away: 'Динамо' };
  const event = {
    id: 18162, date: row.date, start_time: '08:00:00',
    league: { full_name: 'Федерация хоккея Москвы' },
    additional_info: 'Арена Сталкер',
    event_description: '09:30, 2016, Академия Михайлова (Москва) - Динамо',
  };
  const calendar = [row, { ...row, copy: true }, { ...row, id: 2, year: 2017 }, { ...row, id: 3, date: '2026-11-22' }];
  assert.deepEqual(matchFhmBmsIds(calendar, [
    event, { ...event, id: 18163, event_description: '09:35, 2016, Академия Михайлова (Москва) - Динамо' },
    { ...event, id: 18164, event_description: '', additional_info: event.event_description },
    { ...event, id: 18165, league: { short_name: 'КХЛ' } },
  ]), { 23658: 18162 });
  assert.deepEqual(matchFhmBmsIds([row], [event, { ...event, id: 18166 }]), {});
  assert.deepEqual(matchFhmBmsIds([row, { ...row, id: 4 }], [event]), {});
});

test('календарь ДХ: одно гибридное мероприятие может содержать два матча', () => {
  const date = '2026-11-21';
  const rows = [
    { id: 1, date, time: '09:30', year: 2009, home: 'Локомотив-2004', away: 'Динамо' },
    { id: 2, date, time: '12:00', year: 2017, home: 'Спартак', away: 'Динамо' },
  ];
  const event = {
    id: 18162, date, league: { short_name: 'ФХМ' },
    event_description: '9:30, 2009, Локомотив - 2004 2009 — Динамо\r\n12:00, 2017, Спартак – Динамо',
  };
  assert.deepEqual(matchFhmBmsIds(rows, [event]), { 1: 18162, 2: 18162 });
});

test('ФХМ: после 429 сохраняет курсор и продолжает со следующей страницы', async t => {
  const now = Date.now();
  let limited = true;
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    const cursor = url.searchParams.get('cursor');
    if (!cursor) return page([match(1, '2026-11-10T09:20:00+03:00')], 'next');
    if (limited) {
      limited = false;
      return new Response('', { status: 429, headers: { 'Retry-After': '90' } });
    }
    return page([match(2, '2026-11-11T09:20:00+03:00')], null);
  });
  let checkpoint;
  await assert.rejects(loadFhmCalendar('prefix.test', from, to), error => {
    checkpoint = error.progress;
    return error.status === 429 && error.retryAt >= now + 90_000 && checkpoint.cursor === 'next';
  });
  assert.equal(fetch.mock.callCount(), 2);
  const result = await loadFhmCalendar('prefix.test', from, to, { progress: checkpoint });
  assert.deepEqual(result.matches.map(row => row.id), [1, 2]);
  assert.equal(fetch.mock.calls[2].arguments[0].searchParams.get('cursor'), 'next');
});


test('ДХ читает все страницы списка мероприятий БМС за выбранный период', async () => {
  const calls = [];
  const client = { get: async (path, query) => {
    calls.push({ path, query });
    return { items: [{ id: query.page }], pages: 3 };
  } };
  assert.deepEqual(await fetchEvents(client, from, to), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(calls.map(({ path, query }) => [path, query.page, query.date__gte, query.date__lte]),
    [1, 2, 3].map(pageNumber => ['projects/event/list', pageNumber, from, to]));
});

test('ДХ: название арены различает ID 18219 и 18220 при одинаковом описании', () => {
  const row = { id: 24360, date: '2026-11-22', time: '09:15', year: 2017,
    home: 'Снежные барсы', away: 'Запад - Ястребы', venue: 'ЛЦ Снежные барсы' };
  const copy = { ...row, copy: true, venue: 'ЛЦ Снежные барсы_2' };
  const event = { date: row.date, league: { short_name: 'ФХМ' },
    event_description: '09:15, 2017, Снежные барсы - Запад - Ястребы' };
  const regular = { ...event, id: 18219, additional_info: 'ЛЦ «Снежные барсы»_2017' };
  const second = { ...event, id: 18220, additional_info: 'ЛЦ «Снежные барсы»_2_2017' };
  assert.deepEqual(matchFhmBmsIds([row, copy], [
    second, regular, { ...event, id: 18221, additional_info: 'Другая арена' },
  ]), { 24360: 18219, '24360:2': 18220 });
  assert.deepEqual(matchFhmBmsIds([row, copy], [second]), { '24360:2': 18220 });
  assert.deepEqual(matchFhmBmsIds([row, copy], [regular]), { 24360: 18219 });
  assert.deepEqual(matchFhmBmsIds([row, copy], [regular, { ...regular, id: 18222 }]), {});
});

test('ДХ: юниоры в сохранённом календаре выводятся как возрастная группа и сопоставляются с БМС', async () => {
  const row = { id: 321, date: from, time: '17:30', year: null,
    home: 'Спартак Юниоры', away: 'Технопул Юниоры', homeYear: 2008, awayYear: 2009 };
  const { matches } = await withCalendarAddresses({ matches: [row] }, async () => ({}));
  assert.deepEqual(matches.map(({ home, away, ageGroup }) => [home, away, ageGroup]), [
    ['Спартак', 'Технопул', 'Юниоры'],
  ]);
  const event = { id: 18250, date: row.date, league: { short_name: 'ФХМ' } };
  assert.deepEqual(matchFhmBmsIds([row], [
    { ...event, event_description: '17:30, Юниоры, Спартак - Технопул' },
  ]), { 321: 18250 });
  assert.deepEqual(matchFhmBmsIds([row], [
    { ...event, event_description: '17:30, 2008, Спартак Юниоры - Технопул Юниоры' },
  ]), { 321: 18250 });
});
