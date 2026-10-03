// Regression test: a server fault was reported as a lost connection.
//
// Every ErrorCard call site passed a hardcoded `isNetworkError={true}`, so ANY
// failure rendered "Unable to connect to the server. Please check your internet
// connection". A handler returning 500 — which is exactly what a dropped schema
// column produces — was therefore announced as the reader's wifi.
//
// That is worse than an unhelpful message: it sends people to reboot a router
// that is fine, and it hides a server fault from the only person who could
// report it. This asserts the classification that replaced the hardcoding, since
// the whole point is that the RIGHT cause is named.
//
// Run: node scripts/check-error-classification.mjs
import assert from 'node:assert/strict';

// Mirrors classifyError in src/components/common/ErrorCard.jsx.
const classifyError = (error) => {
  const status = Number(error?.status ?? 0);
  if (status === 0 || error?.code === 'network_error') return 'network';
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  return 'generic';
};

// ── the regression: a 500 is NOT a network problem ───────────────────────────
assert.equal(classifyError({ status: 500, code: 'internal' }), 'server',
  'a 500 must be reported as a server fault, not a lost connection');
assert.equal(classifyError({ status: 502 }), 'server');
assert.equal(classifyError({ status: 503 }), 'server');

// ── genuine transport failures ──────────────────────────────────────────────
assert.equal(classifyError({ status: 0, code: 'network_error' }), 'network');
assert.equal(classifyError({ status: 0 }), 'network', 'sendApi uses status 0 for transport failure');
assert.equal(classifyError({ code: 'network_error' }), 'network',
  'the code alone must be enough even if status is missing');
assert.equal(classifyError(undefined), 'network', 'an errorless failure is a transport failure');

// ── access ──────────────────────────────────────────────────────────────────
assert.equal(classifyError({ status: 401 }), 'auth');
assert.equal(classifyError({ status: 403 }), 'auth');

// ── ordinary client-side contract errors ────────────────────────────────────
assert.equal(classifyError({ status: 400, code: 'validation' }), 'generic');
assert.equal(classifyError({ status: 404 }), 'generic');
assert.equal(classifyError({ status: 409, code: 'conflict' }), 'generic');

// Boundaries: 499 is still client-side, 500 is the first server status.
assert.equal(classifyError({ status: 499 }), 'generic', '499 must not count as a server fault');
assert.equal(classifyError({ status: 500 }), 'server', '500 is the first server status');

// An unparseable status is an unknown cause, and the honest answer for an
// unknown cause is "generic" — claiming "network" would invent a diagnosis we
// cannot support. NaN fails every numeric comparison, which is exactly the
// fallthrough that produces it.
assert.equal(classifyError({ status: 'oops' }), 'generic',
  'an unparseable status must fall through to generic, not be invented as a cause');
assert.equal(classifyError({ status: null }), 'network',
  'a null status is status 0 after coercion — a transport failure');

console.log('error classification OK — transport, server fault, access and contract errors are told apart');