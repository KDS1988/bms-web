import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSection, parseUserAccess, storedUserAccess } from '../src/auth.js';

test('ДХ: доступ к календарю и расписанию выдаётся раздельно', () => {
  const calendar = parseUserAccess({ role: 'scoped', permissions: { 'fhm-calendar': 'viewer', board: 'none' } });
  assert.deepEqual(calendar.permissions, { 'fhm-calendar': 'viewer' });
  assert.ok(hasSection(calendar, 'fhm-calendar'));
  assert.ok(!hasSection(calendar, 'fhm-schedule'));
  assert.ok(!hasSection(calendar, 'board'));
  const schedule = parseUserAccess({ role: 'scoped', permissions: { 'fhm-schedule': 'editor' } });
  assert.ok(hasSection(schedule, 'fhm-schedule', 'editor'));
  assert.ok(!hasSection(schedule, 'fhm-calendar'));
});

test('права: просмотр не разрешает запись, неизвестные разделы и пустой доступ отклоняются', () => {
  const studios = parseUserAccess({ role: 'scoped', permissions: { studios: 'viewer' } });
  assert.ok(hasSection(studios, 'studios'));
  assert.ok(!hasSection(studios, 'studios', 'editor'));
  assert.equal(parseUserAccess({ role: 'scoped', permissions: { admin: 'editor' } }), null);
  assert.equal(parseUserAccess({ role: 'scoped', permissions: { board: 'none' } }), null);
  assert.equal(parseUserAccess({ role: 'scoped', permissions: { 'fhm-calendar': 'editor' } }), null);
  assert.equal(parseUserAccess({ role: 'scoped', permissions: { rates: 'admin' } }), null);
});

test('права: старые записи администраторов и серверные роли сохраняются', () => {
  assert.ok(hasSection(storedUserAccess({ name: 'Сотрудник без записи о роли' }), 'rates', 'editor'));
  assert.ok(hasSection({ role: 'editor' }, 'studios', 'editor'));
  assert.ok(!hasSection({ role: 'viewer' }, 'fhm-schedule', 'editor'));
  assert.equal(storedUserAccess({ role: 'unexpected' }), null);
  assert.equal(storedUserAccess(null), null);
});
