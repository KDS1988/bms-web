import test from 'node:test';
import assert from 'node:assert/strict';
import { FhmError, loadFhmCalendar, verifyFhmKey } from '../src/fhm.js';

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
