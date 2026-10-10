import fs from 'fs';
import path from 'path';

// check-no-raw-modal.mjs — the "stuck modal" bug class, made unshippable.
//
// react-bootstrap's <Modal show={show}> closes through a CSS-transition-driven
// exit; when the completion signal is lost (auth state storm re-rendering the
// subtree mid-fade), the dialog stays in EXITING forever — invisible yet
// blocking every click, with body scroll locked. This shipped three times:
// after registration, after email sign-in, and via the profile reputation
// modal. ForumModal cannot hit it (if (!show) return null unmounts the whole
// Modal synchronously), so every modal in the project must go through
// ForumModal. This check fails the build on a raw <Modal> coming back.

const errors = [];

function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (/\.jsx?$/.test(entry.name)) {
      // ForumModal itself is the one file allowed to touch react-bootstrap's
      // Modal; ConfirmModal and friends only wrap ForumModal.
      if (path.basename(fullPath) === 'ForumModal.jsx') continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      // Raw usage: a Modal element in JSX, or a Modal.* compound component —
      // both mean react-bootstrap's Modal is being rendered directly.
      if (/<Modal[\s/>]/.test(content) || /Modal\.(Header|Body|Footer|Title)/.test(content)) {
        errors.push(fullPath);
      }
      // Importing Modal at all is the usual first step of a regression, even
      // before it reaches JSX — only ForumModal may import it.
      if (/import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*'react-bootstrap'/.test(content)) {
        errors.push(`${fullPath} (imports Modal from react-bootstrap)`);
      }
    }
  }
}

scanDir(path.resolve('src'));

if (errors.length > 0) {
  console.error('[FAIL] Raw react-bootstrap <Modal> found outside ForumModal — use ForumModal instead (stuck-modal bug class):');
  errors.forEach(e => console.error(`  - ${e}`));
  process.exit(1);
} else {
  console.log('[OK] No raw react-bootstrap modals in src/ — every modal goes through ForumModal');
}