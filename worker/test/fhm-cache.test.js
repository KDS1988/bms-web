import test from 'node:test';
import assert from 'node:assert/strict';
import { readFhmCache, writeFhmCache, deleteFhmCache } from '../src/fhm-cache.js';

test('снимок ФХМ: превышающие лимит записи данные делятся на части и читаются целиком', async () => {
  const map = new Map();
  const storage = {
    get: key => Array.isArray(key) ? new Map(key.flatMap(k => map.has(k) ? [[k, map.get(k)]] : [])) : map.get(key),
    put: entries => Object.entries(entries).forEach(([key, value]) => map.set(key, value)),
    delete: keys => keys.forEach(key => map.delete(key)),
    transaction: fn => fn(storage),
  };
  const rows = Array.from({ length: 800 }, () => Array.from(
    crypto.getRandomValues(new Uint8Array(256)), byte => byte.toString(16).padStart(2, '0'),
  ).join(''));
  const saved = await writeFhmCache(storage, 'month', { rows });
  assert.ok(map.get('month').chunks > 1);
  assert.deepEqual(await readFhmCache(storage, 'month'), saved);
  await writeFhmCache(storage, 'month', { rows: [] });
  assert.deepEqual([...map.keys()], ['month', 'month:0']);
  await deleteFhmCache(storage, 'month');
  assert.equal(await readFhmCache(storage, 'month'), null);
  assert.equal(map.size, 0);
});
