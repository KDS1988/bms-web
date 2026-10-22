import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../docs/studios-core.js');
const m = (id, start, end, o = {}) => ({ id, date: '2026-03-01', start, end, project: 'A', studio: 'К', pc: '', status: '', ...o });

test('ПК: пересечение и допуск', () => {
  const a = m(1, '10:00', '12:00', { pc: '01' }), b = m(2, '11:50', '13:00', { pc: '01' }), c = m(3, '12:00', '13:00', { pc: '01' });
  assert.equal(C.pcConflicts(b, [a, b, c], 0).length, 2);
  assert.equal(C.pcConflicts(b, [a, b], 10).length, 0);       // нахлёст 10 мин допущен
  assert.equal(C.pcConflicts(c, [a, c], 0).length, 0);        // встык — не конфликт
  assert.equal(C.pcConflicts(m(4, '11:00', '12:30', { pc: '02' }), [a], 0).length, 0);
  assert.equal(C.pcConflicts({ ...b, status: 'отмена' }, [a], 0).length, 0);
});
test('ВР: пауза, параллель и минимум', () => {
  const a = m(1, '10:00', '12:00'), b = m(2, '12:10', '14:00'), c = m(3, '11:00', '13:00', { project: 'B' });
  assert.equal(C.canTake([a], b, { pause: 15, cap: 1 }), false);
  assert.equal(C.canTake([a], b, { pause: 10, cap: 1 }), true);
  assert.equal(C.canTake([a], c, { pause: 5, cap: 3 }), false);   // другой проект — параллели нет
  const d = m(4, '10:30', '12:30');
  assert.equal(C.canTake([a], d, { pause: 5, cap: 1 }), false);
  assert.equal(C.canTake([a], d, { pause: 5, cap: 2 }), true);
  assert.equal(C.minVr([a, b, c, d], { pause: 15, cap: 1 }).count, 4);
  assert.equal(C.minVr([a, b, d], { pause: 5, cap: 2 }).count, 1);
  assert.equal(C.minVr([a, { ...b, status: 'отмена' }], { pause: 5, cap: 1 }).count, 1);
  assert.equal(C.span(m(5, '23:00', '01:00'))[1], 1500);
});
