import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportSnapshot, importSnapshot } from './transfer.mjs';
import { planReimport } from './snapshot.mjs';
import { firebaseSource } from './firebase-source.mjs';

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
// Exclusive create: snapshots/ledgers are immutable artifacts, never overwrite.
const writeJSON = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export async function main(args) {
  const [command, ...paths] = args;
  if (command === 'export' && paths.length === 2) {
    const [projectId, output] = paths;
    const source = firebaseSource(projectId);
    try {
      await writeJSON(output, await exportSnapshot(source, { projectId }));
    } finally {
      await source.close();
    }
  } else if (command === 'diff' && paths.length === 3) {
    await writeJSON(paths[2], planReimport(await readJSON(paths[0]), await readJSON(paths[1])));
  } else if (command === 'stage' && paths.length === 3) {
    const [snapshotPath, previousPath, output] = paths;
    const result = importSnapshot(await readJSON(snapshotPath), previousPath === '-' ? null : await readJSON(previousPath));
    await writeJSON(output, result.ledger);
    console.log(JSON.stringify(result.report));
  } else {
    throw new Error('Usage: export PROJECT OUTPUT | diff OLD NEW REPORT | stage SNAPSHOT PREVIOUS_LEDGER_OR_- OUTPUT_LEDGER');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
