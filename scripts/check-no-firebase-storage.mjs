import fs from 'fs';
import path from 'path';

function scanDir(dir, errors = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, errors);
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('firebasestorage.googleapis.com')) {
        errors.push(fullPath);
      }
    }
  }
  return errors;
}

const errors = scanDir(path.resolve('src'));
if (errors.length > 0) {
  console.error('[FAIL] Found Firebase Storage references in:');
  errors.forEach(e => console.error(`  - ${e}`));
  process.exit(1);
} else {
  console.log('[OK] No Firebase Storage references found in src/');
}
