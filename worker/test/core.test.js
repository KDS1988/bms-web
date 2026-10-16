import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, buildRow, isTargetItem } from '../src/board.js';
import { BmsClient, assignEmployee, AlreadyExistsError } from '../src/bms.js';
import { findMissingRates, fixRates } from '../src/rates.js';
import { buildStaff, buildCandidates, dateRange } from '../src/staff.js';
import { signSession, verifySession, roleFor, hasRole, verifyGoogleIdToken, b64urlEncode } from '../src/auth.js';

const emp = (id, last, first, lineId, cat) => ({
  id, last_name: last, first_name: first, middle_name: '', phone_number: '+7',
  user_job_titles: [], user_line_categories: [{ line: { id: lineId }, category: cat }],
});

const item = (over = {}) => ({
  id: 100,
  service: { name: 'Прямая трансляция' },
  service_status: 'ok',
  additional_services: [],
  event: {
    id: 1, date: '2026-10-20', start_time: '18:00:00', end_time: '21:00:00',
    league: { short_name: 'КХЛ' }, home_team: { name: 'А' }, away_team: { name: 'Б' },
    event_description: '', additional_info: '', sport_type: {},
  },
  event_service_lines: [
    { id: 11, line: { id: 1, name: 'Выпускающий режиссер' }, status: 'x',
      assignment_technical: { id: 5, status: 'appointed', employee: emp(7, 'Иванов', 'Иван', 1, 'A'), expense_assignment_technical: { id: 1 }, logistics: null }, assignment_contractor: null },
    { id: 12, line: { id: 2, name: 'Оператор' }, status: 'x', assignment_technical: null, assignment_contractor: null },
  ],
  ...over,
});

test('фильтр доски: только нужные услуги, без ХЛТР/ФХМ', () => {
  assert.equal(isTargetItem(item()), true);
  assert.equal(isTargetItem(item({ service: { name: 'Запись' } })), false);
  const bad = item(); bad.event.league.short_name = 'ХЛТР';
  assert.equal(isTargetItem(bad), false);
});

test('buildBoard: строка, слоты и статистика', () => {
  const board = buildBoard([item(), item({ service: { name: 'Запись' }, id: 101 })]);
  const rows = board.days.flatMap(d => d.rows);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row.stats.total >= 2);
  assert.equal(row.stats.filled, 1);
  assert.equal(row.stats.accepted, 1);
  assert.equal(row.stats.noRate, 0);
});

test('buildRow: назначение без ставки отмечается', () => {
  const it = item();
  it.event_service_lines[0].assignment_technical.expense_assignment_technical = null;
  assert.equal(buildRow(it).stats.noRate, 1);
});

const fakeFetch = routes => async (url, opts) => {
  const key = `${opts.method} ${new URL(url).pathname.replace('/api/v1/bms/', '')}`;
  const r = routes[key];
  if (!r) return new Response('nf', { status: 404 });
  const res = typeof r === 'function' ? r(opts) : r;
  return new Response(res.body === undefined ? '' : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)), { status: res.status || 200 });
};

test('assignEmployee: два шага, для ВР — логистика и допуслуги', async () => {
  const calls = [];
  const f = fakeFetch({
    'GET projects/event_service_additional_service/100': { body: [{ id: 91, additional_service_id: 8 }, { id: 92, additional_service_id: 10 }, { id: 93, additional_service_id: 3 }] },
    'POST projects/assignment/technical': o => { calls.push(JSON.parse(o.body)); return { body: { id: 555 } }; },
    'POST accounting/expense/assignment/technical': o => { calls.push(JSON.parse(o.body)); return { body: {} }; },
  });
  const c = new BmsClient(async () => 't', f);
  const res = await assignEmployee(c, { eventServiceId: 100, lineId: 11, employeeId: 7, isVr: true });
  assert.equal(res.rate, 'ok');
  assert.deepEqual(calls[0].event_service_additional_service_list, [91, 92]);
  assert.match(calls[0].logistics, /удаленно/);
  assert.equal(calls[1].assignment_technical_id, 555);
  assert.equal(calls[1].line_manual_rate, null);
});

test('assignEmployee: провал ставки не глотается', async () => {
  const f = fakeFetch({
    'POST projects/assignment/technical': { body: { id: 1 } },
    'POST accounting/expense/assignment/technical': { status: 422, body: 'bad' },
  });
  const res = await assignEmployee(new BmsClient(async () => 't', f), { eventServiceId: 1, lineId: 1, employeeId: 1, isVr: false });
  assert.equal(res.rate, 'failed');
  assert.ok(res.rateError);
});

test('дубликат -> AlreadyExistsError', async () => {
  const f = fakeFetch({ 'POST projects/assignment/technical': { status: 400, body: '{"detail":"Assignment technical with such data already exists"}' } });
  await assert.rejects(
    assignEmployee(new BmsClient(async () => 't', f), { eventServiceId: 1, lineId: 1, employeeId: 1, isVr: false }),
    e => e instanceof AlreadyExistsError);
});

test('401 -> один раз обновляем токен и повторяем', async () => {
  let n = 0; const forced = [];
  const f = async () => (++n === 1 ? new Response('', { status: 401 }) : new Response('{"ok":1}', { status: 200 }));
  const c = new BmsClient(async force => { forced.push(force); return 't'; }, f);
  assert.deepEqual(await c.get('x'), { ok: 1 });
  assert.deepEqual(forced, [false, true]);
});

test('ставки: поиск и доначисление', async () => {
  const it = item();
  it.event_service_lines[0].assignment_technical.expense_assignment_technical = null;
  const missing = findMissingRates([it]);
  assert.equal(missing.length, 1);
  const f = fakeFetch({ 'POST accounting/expense/assignment/technical': { body: {} } });
  const res = await fixRates(new BmsClient(async () => 't', f), missing);
  assert.equal(res.fixed.length, 1);
  assert.equal(res.failed.length, 0);
});

test('график: статусы дней и кандидаты (свободные сверху)', () => {
  const entries = [
    { employee: emp(1, 'Бабич', 'А', 1, 'A'), days: [{ date: '2026-10-20', is_dayoff: true, assignments: [] }] },
    { employee: emp(2, 'Воронов', 'Б', 1, 'B'), days: [{ date: '2026-10-20', assignments: [{ event_service: { event: { date: '2026-10-20', start_time: '10:00:00', league: { short_name: 'КХЛ' }, home_team: { name: 'А' }, away_team: { name: 'Б' } } } }] }] },
    { employee: emp(3, 'Яковлев', 'В', 1, 'C'), days: [] },
  ];
  const c = buildCandidates(entries, '2026-10-20', 1);
  assert.deepEqual(c.map(x => x.state), ['free', 'busy', 'off']);
  assert.equal(c[0].category, 'C');
  const st = buildStaff([{ line: { id: 1, name: 'ВР' }, entries }], dateRange('2026-10-20', '2026-10-21'));
  assert.equal(st.employees.length, 3);
  assert.equal(st.employees[0].days['2026-10-20'].state, 'off');
});

test('сессия и роли', async () => {
  const tok = await signSession({ email: 'a@b.ru' }, 'secret');
  assert.equal((await verifySession(tok, 'secret')).email, 'a@b.ru');
  assert.equal(await verifySession(tok, 'other'), null);
  const old = await signSession({ email: 'a@b.ru' }, 'secret', 10, Date.now() - 60_000);
  assert.equal(await verifySession(old, 'secret'), null);
  const env = { ADMIN_EMAILS: 'Boss@x.ru', EDITOR_EMAILS: '@vsporte.ru', VIEWER_EMAILS: 'v@y.ru' };
  assert.equal(roleFor('boss@x.ru', env), 'admin');
  assert.equal(roleFor('any@vsporte.ru', env), 'editor');
  assert.equal(roleFor('v@y.ru', env), 'viewer');
  assert.equal(roleFor('z@z.ru', env), null);
  assert.ok(hasRole('admin', 'editor') && !hasRole('viewer', 'editor'));
});

test('Google ID-токен: подпись, aud, срок', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  const enc = new TextEncoder();
  const mk = async (claims, key = kp.privateKey) => {
    const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
    const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
    const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${p}`));
    return `${h}.${p}.${b64urlEncode(new Uint8Array(s))}`;
  };
  const base = { iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, email: 'A@B.ru', email_verified: true, name: 'A' };
  const opts = { clientId: 'cid', fetchJwks: async () => ({ keys: [jwk] }) };
  assert.equal((await verifyGoogleIdToken(await mk(base), opts)).email, 'a@b.ru');
  await assert.rejects(verifyGoogleIdToken(await mk({ ...base, aud: 'x' }), opts), /bad_audience/);
  await assert.rejects(verifyGoogleIdToken(await mk({ ...base, exp: 1 }), opts), /expired/);
  await assert.rejects(verifyGoogleIdToken(await mk({ ...base, email_verified: false }), opts), /email_not_verified/);
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  await assert.rejects(verifyGoogleIdToken(await mk(base, other.privateKey), opts), /bad_signature/);
});
