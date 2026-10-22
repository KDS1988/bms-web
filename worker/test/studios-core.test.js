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

test('ПК: авторасстановка с кабинками', () => {
  const k = (id, st, en, o = {}) => m(id, st, en, { studio: 'Калужская', ...o });
  const all = [k(1, '10:00', '12:00', { comm: 'Иван Иванов' }), k(2, '10:30', '12:30', { comm: 'Пётр Петров' }), k(3, '10:00', '12:00', { comm: 'со стадиона' }), k(4, '11:00', '13:00', { comm: '' }), k(5, '12:00', '14:00', { comm: 'Иван Иванов' }), k(6, '10:00', '12:00', { studio: 'Алматы' })];
  const r = C.planPcs(all, all, 0);
  assert.equal(r.assign[1], '01'); assert.equal(r.assign[2], '02');
  assert.equal(r.assign[3], '12');                                       // «со стадиона» — без кабинки
  assert.equal(r.assign[4], '03');                                       // комментатор не проставлен — кабинка нужна
  assert.equal(r.assign[5], '01');                                       // освободился после 12:00
  assert.equal(C.needsCabin({ comm: '', cabin: 'нет' }), false); assert.equal(C.needsCabin({ comm: '' }), true);
  assert.equal(r.assign[6], undefined);
  const busy = Array.from({ length: 7 }, (_, i) => k(100 + i, '10:00', '12:00', { pc: C.PC_POOLS['Калужская'].plain[i] }));
  const x = k(200, '11:00', '12:00', { comm: '', cabin: 'нет' });
  assert.equal(C.planPcs([...busy, x], [x], 0).miss.length, 1);
  assert.equal(C.planPcs([k(1, '10:00', '12:00', { pc: '01', comm: 'А Б' }), k(2, '11:00', '13:00', { comm: 'А Б' })], [k(2, '11:00', '13:00', { comm: 'А Б' })], 0).assign[2], '02');
});

test('ВР: авторасстановка', () => {
  const info = { today: '2026-10-22', vrs: {
    'Опытный А': { n: 100, last: '2026-10-20', label: 'опытный', proj: { 'КХЛ_ПАК': 80 } },
    'Опытный Б': { n: 90, last: '2026-10-20', label: 'опытный', proj: { 'НСФЛ': 50 } },
    'Новичок': { n: 5, last: '2026-10-20', label: 'новичок', proj: {} },
    'Старый': { n: 100, last: '2025-01-01', label: 'опытный', proj: { 'КХЛ_ПАК': 99 } } } };
  const a = m(1, '10:00', '12:00', { project: 'КХЛ_ПАК', date: '2026-10-25' }), b = m(2, '12:20', '14:00', { project: 'КХЛ_ПАК', date: '2026-10-25' });
  const c = m(3, '10:30', '12:30', { project: 'НСФЛ', date: '2026-10-25' });
  const r = C.planVrs([a, b, c], [a, b, c], info, { pause: 15, cap: 1 });
  assert.equal(r.assign[1], 'Опытный А'); assert.equal(r.assign[2], 'Опытный А');   // тот же человек подряд
  assert.equal(r.assign[3], 'Опытный Б');
  const d = m(4, '10:00', '12:00', { project: 'КХЛ_ПАК', date: '2026-10-25', vr: 'Опытный А' });
  const r2 = C.planVrs([d, a], [a], info, { pause: 15, cap: 1 });
  assert.notEqual(r2.assign[1], 'Опытный А');                                       // занят в это время
  assert.notEqual(r2.assign[1], 'Старый');                                          // давно не работал
});

test('связь с BMS: имя, автосвязка, состояние ВР', () => {
  assert.equal(C.nameKey('Кармен Клещевич'), C.nameKey('Клещевич  Кармен'));
  const rows = [{ date: '2026-03-01', start: '03:00', title: 'WTA 500 Мерида. Полуфинал 1', league: 'Рестрим КП Беларусь' }, { date: '2026-03-01', start: '03:00', title: 'Другое', league: 'Хоккей' }, { date: '2026-03-02', start: '03:00', title: 'WTA 500 Мерида. Полуфинал 1', league: 'Рестрим КП Беларусь' }];
  const mm = m(1, '02:55', '04:30', { date: '2026-03-01', project: 'Рестрим КП Беларусь', t1: 'WTA 500 Мерида. Полуфинал 1', evStart: '03:00' });
  assert.equal(C.autoLink(mm, rows), rows[0]);
  assert.equal(C.autoLink({ ...mm, date: '2026-03-05' }, rows), null);
  const row = { slots: { vr: [{ employee: { name: 'Клещевич Кармен' }, status: 'pending' }] } };
  assert.equal(C.vrState({ vr: 'Кармен Клещевич' }, row).code, 'pending');
  assert.equal(C.vrState({ vr: 'Иван Иванов' }, row).code, 'other');
  assert.equal(C.vrState({ vr: '' }, { slots: { vr: [{ employee: null }] } }).code, 'missing');
  assert.equal(C.vrState({ vr: 'А Б' }, null).code, 'none');
});

test('имя: отчество в BMS не мешает', () => {
  assert.ok(C.sameName('Кармен Клещевич', 'Клещевич Кармен Игоревна'));
  assert.ok(C.sameName('Иванов Иван', 'Иван Иванов'));
  assert.ok(!C.sameName('Иван Иванов', 'Иван Петров'));
  assert.ok(!C.sameName('Иван', 'Иван Иванов'));
  assert.equal(C.vrState({ vr: 'Кармен Клещевич' }, { slots: { vr: [{ employee: { name: 'Клещевич Кармен' }, status: 'appointed' }] } }).code, 'appointed');
});
