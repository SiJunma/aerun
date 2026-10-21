import { createRequire } from 'node:module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

let failed = false;

function checkDeps(label, deps) {
  for (const name of Object.keys(deps || {})) {
    if (/^firebase(-|$)/i.test(name)) {
      console.error(`[FAIL] Firebase package in ${label}: ${name}@${deps[name]}`);
      failed = true;
    }
  }
}

checkDeps('dependencies', pkg.dependencies);
checkDeps('devDependencies', pkg.devDependencies);

// Lockfile check
try {
  const lock = JSON.parse(fs.readFileSync('../package-lock.json', 'utf8'));
  const pkgs = lock.packages || {};
  for (const path of Object.keys(pkgs)) {
    if (/node_modules\/firebase(-|$)/i.test(path)) {
      console.error(`[FAIL] Firebase package in lockfile: ${path}@${pkgs[path].version}`);
      failed = true;
    }
  }
} catch { /* lockfile may not exist */ }

// Scripts check: firebase CLI must not appear in npm scripts
// (script names like test:no-firebase-* are excluded on purpose)
for (const [name, value] of Object.entries(pkg.scripts || {})) {
  if (/no-firebase/i.test(name)) continue;
  if (/(?:^|[^-])firebase/i.test(value)) {
    console.error(`[FAIL] Firebase CLI in npm script "${name}": ${value}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('[OK] No Firebase packages or CLI references found in root package.json / lockfile / scripts');
