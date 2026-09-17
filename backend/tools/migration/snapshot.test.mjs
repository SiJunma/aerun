import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSnapshot, importSnapshot } from './transfer.mjs';
import { planReimport } from './snapshot.mjs';

const row = (path, content) => ({ kind: 'firestore', path, data: { content } });
const snapshot = (records, time = '2026-09-17T10:00:00Z', projectId = 'mock-only') =>
  exportSnapshot({ async *records() { yield* records; } }, { projectId, clock: () => time });
test('optional Auth fields survive JSON serialization with valid checksums', async () => {
  const first = await snapshot([{ kind: 'auth', path: 'user', data: {
    uid: 'user', providerData: [{ providerId: 'google.com', phoneNumber: undefined }],
  } }]);
  const restored = JSON.parse(JSON.stringify(first));
  assert.deepEqual(importSnapshot(restored).ledger, importSnapshot(first).ledger);
});



test('export order and replay are deterministic', async () => {
  const first = await snapshot([row('posts/a', 'first'), row('posts/b', 'second')]);
  assert.deepEqual(first, await snapshot([row('posts/b', 'second'), row('posts/a', 'first')]));
  const initial = importSnapshot(first);
  assert.equal(initial.report.created, 2);
  const replay = importSnapshot(first, initial.ledger);
  assert.deepEqual(replay.ledger, initial.ledger);
  assert.equal(replay.report.unchanged, 2);
});

test('reimport updates source rows without deleting missing rows or mutating input', async () => {
  const first = await snapshot([row('posts/a', 'first'), row('posts/b', 'second')]);
  const next = await snapshot([row('posts/a', 'edited'), row('posts/c', 'new')], '2026-09-17T11:00:00Z');
  const initial = importSnapshot(first).ledger;
  const saved = structuredClone(initial);
  const merged = importSnapshot(next, initial);
  assert.deepEqual(initial, saved);
  assert.deepEqual(merged.report, { created: 1, updated: 1, unchanged: 0, missingCandidates: ['firestore:posts/b'] });
  assert.equal(merged.ledger.records.length, 3);
  assert.deepEqual(importSnapshot(next, merged.ledger).ledger, merged.ledger);
  const diff = planReimport(first, next);
  assert.equal(diff.create.length, 1);
  assert.equal(diff.update.length, 1);
  assert.equal(diff.missingCandidates.length, 1);
});

test('corruption, stale data, duplicate identities and other projects are rejected', async () => {
  const first = await snapshot([row('posts/a', 'first')]);
  const newer = await snapshot([], '2026-09-17T11:00:00Z');
  const corrupt = structuredClone(first);
  corrupt.records[0].data.content = 'corrupt';
  assert.throws(() => importSnapshot(corrupt), /checksum/);
  assert.throws(() => importSnapshot(first, importSnapshot(newer).ledger), /stale/);
  const other = await snapshot([], '2026-09-17T12:00:00Z', 'other');
  assert.throws(() => importSnapshot(other, importSnapshot(first).ledger), /Project mismatch/);
  await assert.rejects(snapshot([row('posts/a', 'one'), row('posts/a', 'two')]), /Duplicate/);
});
