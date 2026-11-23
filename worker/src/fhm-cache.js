const CHUNK_SIZE = 96 * 1024;

export async function readFhmCache(storage, key) {
  const snapshot = await storage.transaction(async txn => {
    const record = await txn.get(key);
    if (!record) return null;
    const keys = Array.from({ length: record.chunks }, (_, i) => `${key}:${i}`);
    const parts = await txn.get(keys);
    return { at: record.at, parts: keys.map(part => parts.get(part)) };
  });
  if (!snapshot) return null;
  const stream = new Blob(snapshot.parts).stream().pipeThrough(new DecompressionStream('gzip'));
  return { value: await new Response(stream).json(), at: snapshot.at };
}

export async function writeFhmCache(storage, key, value) {
  const compressed = new Uint8Array(await new Response(new Blob([JSON.stringify(value)])
    .stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const chunks = Math.ceil(compressed.length / CHUNK_SIZE);
  const at = Date.now();
  await storage.transaction(async txn => {
    const previous = await txn.get(key);
    const entries = { [key]: { at, chunks } };
    for (let i = 0; i < chunks; i++) entries[`${key}:${i}`] = compressed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await txn.put(entries);
    if (previous?.chunks > chunks) {
      await txn.delete(Array.from({ length: previous.chunks - chunks }, (_, i) => `${key}:${i + chunks}`));
    }
  });
  return { at, value };
}

export async function deleteFhmCache(storage, key) {
  await storage.transaction(async txn => {
    const previous = await txn.get(key);
    if (previous) await txn.delete([key, ...Array.from({ length: previous.chunks }, (_, i) => `${key}:${i}`)]);
  });
}
