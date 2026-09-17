import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const checksum = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = record => `${record.kind}:${record.path}`;

export function sealSnapshot({ projectId, startedAt, finishedAt, records }) {
  const snapshot = {
    version: 1, projectId, startedAt, finishedAt,
    consistency: 'live-non-atomic',
    scope: ['firestore', 'auth-metadata'],
    records: records.map(record => {
      const data = JSON.parse(JSON.stringify(record.data));
      return { kind: record.kind, path: record.path, data, hash: checksum(data) };
    }).sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0),
  };
  const sealed = { ...snapshot, checksum: checksum(snapshot) };
  validateSnapshot(sealed);
  return sealed;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.projectId !== 'string' || !snapshot.projectId.trim()) {
    throw new Error('Invalid snapshot version or project ID');
  }
  const { checksum: expected, ...payload } = snapshot;
  if (checksum(payload) !== expected) throw new Error('Snapshot checksum mismatch');
  if (!Array.isArray(snapshot.records) || canonical(snapshot.scope) !== canonical(['firestore', 'auth-metadata'])) {
    throw new Error('Incomplete or unsupported snapshot scope');
  }
  for (const key of ['startedAt', 'finishedAt']) {
    if (!Number.isFinite(Date.parse(snapshot[key]))) throw new Error(`Invalid ${key}`);
  }
  if (Date.parse(snapshot.finishedAt) < Date.parse(snapshot.startedAt)) throw new Error('Invalid snapshot interval');
  const seen = new Set();
  for (const record of snapshot.records) {
    if (!['firestore', 'auth'].includes(record.kind) || typeof record.path !== 'string' || !record.path || record.data == null) {
      throw new Error('Invalid record');
    }
    if (checksum(record.data) !== record.hash) throw new Error(`Record checksum mismatch: ${identity(record)}`);
    if (seen.has(identity(record))) throw new Error(`Duplicate record: ${identity(record)}`);
    seen.add(identity(record));
  }
  return snapshot;
}

// A plan only: no writes, deletes or source access. Absence is NOT a tombstone
// when an export was captured while writers were active.
export function planReimport(previous, next) {
  validateSnapshot(previous);
  validateSnapshot(next);
  if (previous.projectId !== next.projectId) throw new Error('Cannot compare different Firebase projects');
  if (Date.parse(next.startedAt) < Date.parse(previous.startedAt)) throw new Error('Refusing an older snapshot');
  const old = new Map(previous.records.map(record => [identity(record), record]));
  const result = {
    version: 1, projectId: next.projectId,
    baseline: previous.checksum, snapshot: next.checksum,
    create: [], update: [], unchanged: 0, missingCandidates: [],
    deletionPolicy: 'manual-review-only',
  };
  for (const record of next.records) {
    const key = identity(record);
    const before = old.get(key);
    if (!before) result.create.push({ kind: record.kind, path: record.path, hash: record.hash });
    else if (before.hash !== record.hash) result.update.push({ kind: record.kind, path: record.path, beforeHash: before.hash, hash: record.hash });
    else result.unchanged++;
    old.delete(key);
  }
  result.missingCandidates = [...old.values()].map(({ kind, path, hash }) => ({ kind, path, beforeHash: hash }));
  return result;
}
