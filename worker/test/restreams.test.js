import test from 'node:test';
import assert from 'node:assert/strict';
import { getRestreamDecision, parseRestreamRules, restreamEvents, restreamRow, restreamSources } from '../src/restreams.js';

const event = {
  id: 101, date: '2026-11-22', start_time: '14:30:00', end_time: '16:15:00',
  home_team: { name: 'Хозяева' }, away_team: { name: 'Гости' }, league: { short_name: 'Лига' },
};
const service = { id: 201, service: { name: 'Ретрансляция' }, event };
const [row] = restreamEvents([service], '2026-11-01', '2026-11-30');

test('only BMS retransmissions for the period become rows, with independent service IDs', () => {
  const items = [
    null, service, service,
    { ...service, id: 202 },
    { ...service, id: 203, service: { name: 'Прямая трансляция' } },
    { ...service, id: 204, event: { ...event, date: '2026-12-01' } },
  ];
  assert.deepEqual(restreamEvents(items, '2026-11-01', '2026-11-30').map(({ eventServiceId, eventId, start }) =>
    [eventServiceId, eventId, start]), [[201, 101, '14:30'], [202, 101, '14:30']]);
});

test('sheet values match by event ID, and an explicit No overrides the legacy selection', () => {
  const legacy = { eventId: '101', streams: { rtmp: { needed: true, params: { protocol: 'RTMP', address: 'rtmp://example.com/live', key: 'example' } } } };
  const sources = restreamSources({ rows: [{ ...legacy, eventId: 201 }, legacy] });
  assert.equal(restreamRow(row, {}, sources, []).streams.rtmp.params.key, 'example');
  assert.deepEqual(restreamRow(row, { rtmp: false }, sources, []).streams.rtmp, { needed: false });
  assert.equal(restreamRow(row, {}, sources, []).streams.tricolor.needed, null);
});

test('server SRT source and recipient templates fill settings only for selected streams', () => {
  const sources = restreamSources({ srt: [{ eventId: 101, params: { protocol: 'SRT LISTENER', address: 'srt.example.com', port: '10108' } }] });
  const rules = parseRestreamRules([{ recipient: 'rtmp', match: { league: 'ЛИГА' },
    params: { protocol: 'RTMP', address: 'rtmp://example.com/live', key: '{eventId}_{ddmmyyyy}' } }]);
  const { streams } = restreamRow(row, { srt: true, rtmp: true, kp: true }, sources, rules);
  assert.equal(streams.srt.params.port, '10108');
  assert.deepEqual(streams.srt.missing, []);
  assert.equal(streams.rtmp.params.key, '101_22112026');
  assert.deepEqual(streams.kp.missing, ['protocol', 'address']);
});

test('conflicting sheet mappings are ignored and missing placeholders stay visibly incomplete', () => {
  const sources = restreamSources({ rows: [{ eventId: 101, setup: { pc: '01' } }, { eventId: 101, setup: { pc: '02' } }] });
  const rules = parseRestreamRules([{ recipient: 'kp', match: {},
    params: { protocol: 'SRT CALLER', address: 'srt.example.com', port: '10108', passphrase: '{pass}' } }]);
  const result = restreamRow(row, { kp: true }, sources, rules).streams.kp;
  assert.deepEqual(result.missing, ['passphrase']);
  assert.equal(result.ambiguous, true);
  assert.equal(result.params.passphrase, undefined);
});

test('validates stream edits and configuration without coercing bad values into decisions', () => {
  assert.deepEqual(getRestreamDecision({ eventServiceId: '201', recipient: 'kp', needed: false }),
    { eventServiceId: 201, recipient: 'kp', needed: false });
  assert.equal(getRestreamDecision({ eventServiceId: 201, recipient: 'kp', needed: 'нет' }), null);
  assert.equal(getRestreamDecision({ eventServiceId: 201, recipient: 'other', needed: true }), null);
  assert.equal(parseRestreamRules([{ recipient: 'kp', match: {}, params: { protocol: 'SRT', address: '{anything}' } }]), null);
});
