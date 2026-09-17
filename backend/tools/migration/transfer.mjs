import { sealSnapshot, validateSnapshot, checksum } from './snapshot.mjs';

// SDK-specific reads stay in the source adapter. No credentials or network here.
export async function exportSnapshot(source, { projectId, clock = () => new Date().toISOString() }) {
  const startedAt = clock();
  const records = [];
  for await (const record of source.records()) records.push(record);
  return sealSnapshot({ projectId, startedAt, finishedAt: clock(), records });
}

// Offline staging only, NOT the domain database. The complete source identity is
// retained; PocketBase IDs and relation mapping belong to the future PB importer.
// Copy-on-write: errors never mutate the caller's ledger. Missing rows are kept.
export function importSnapshot(snapshot, ledger = null) {
  validateSnapshot(snapshot);
  if (ledger !== null) {
    const { checksum: expected, ...payload } = ledger;
    if (checksum(payload) !== expected || ledger.version !== 1 || !Array.isArray(ledger.records)) {
      throw new Error('Invalid staging ledger');
    }
    if (ledger.projectId !== snapshot.projectId) throw new Error('Project mismatch');
    if (Date.parse(snapshot.startedAt) < Date.parse(ledger.startedAt)) throw new Error('Refusing stale import');
  }
  const previous = new Map((ledger?.records ?? []).map(record => [`${record.kind}:${record.path}`, record]));
  const report = { created: 0, updated: 0, unchanged: 0, missingCandidates: [] };
  const seen = new Set();
  for (const record of snapshot.records) {
    const key = `${record.kind}:${record.path}`;
    const before = previous.get(key);
    if (!before) report.created++;
    else if (before.hash === record.hash) report.unchanged++;
    else report.updated++;
    previous.set(key, structuredClone(record));
    seen.add(key);
  }
  report.missingCandidates = [...previous.keys()].filter(key => !seen.has(key)).sort();
  const state = {
    version: 1, projectId: snapshot.projectId, startedAt: snapshot.startedAt,
    snapshot: snapshot.checksum,
    records: [...previous.values()].sort((a, b) => {
      const left = `${a.kind}:${a.path}`;
      const right = `${b.kind}:${b.path}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
  return { ledger: { ...state, checksum: checksum(state) }, report };
}
