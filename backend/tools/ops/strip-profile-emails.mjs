// One-off operational tool: run the root-only `stripProfileEmails` callable in
// production and prove the result is idempotent.
//
// Why this exists: the legacy public Firestore `users` documents still carry a
// copy of the account email while `firestore.rules` grants `allow read: if true`
// on that collection, so those addresses are world readable. The canonical
// address already lives in Firebase Auth; see the plan section "Why the email
// copy is removed, and what does NOT depend on it".
//
// Why the custom-token detour: the callable deliberately requires a real root
// user session (`request.auth.uid` + Firestore role `root`), so a service
// account token is not enough. This tool signs a Firebase custom token for the
// root uid, exchanges it for an ID token, and then calls the deployed callable
// exactly like the browser would. It needs a service account key with signing
// rights and NO other project role; delete that key right after the run.
//
// Dependency free: node:crypto + global fetch only, so no firebase-admin install
// and no bundle to keep up to date.
//
// Usage (from the repository root):
//   node backend/tools/ops/strip-profile-emails.mjs
// Environment overrides:
//   AERUN_SA_KEY      service account JSON (default .secrets/aerun-service-account.json)
//   AERUN_PROJECT     Firebase project id (default aerun-forum)
//   AERUN_REGION      callable region (default us-central1)
//   AERUN_ROOT_UID    skip the email lookup and use this uid
//   AERUN_ROOT_EMAIL  root account email (default: VITE_ADMIN_EMAIL from .env.production)
//   AERUN_WEB_API_KEY Firebase web API key (default: VITE_FIREBASE_API_KEY from .env.production)
//
// Output never contains an email address: only counts and the pagination cursor.

import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";
const CUSTOM_TOKEN_AUDIENCE = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

const project = process.env.AERUN_PROJECT ?? "aerun-forum";
const region = process.env.AERUN_REGION ?? "us-central1";
const maxBatches = 50;

const readEnvValue = (fileName, key) => {
  const path = resolve(REPO_ROOT, fileName);
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
};

const base64Url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const signJwt = (payload, privateKey) => {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const signingInput = `${header}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const keyPath = resolve(REPO_ROOT, process.env.AERUN_SA_KEY ?? ".secrets/aerun-service-account.json");
if (!existsSync(keyPath)) fail(`service account key not found at ${keyPath}`);
const key = JSON.parse(readFileSync(keyPath, "utf8"));
if (!key.client_email || !key.private_key) fail("service account key is missing client_email/private_key");
if (key.project_id && key.project_id !== project) {
  fail(`key belongs to project ${key.project_id}, expected ${project} (override with AERUN_PROJECT)`);
}
console.log(`project=${project} caller=${key.client_email} region=${region}`);

const webApiKey = process.env.AERUN_WEB_API_KEY ?? readEnvValue(".env.production", "VITE_FIREBASE_API_KEY");
if (!webApiKey) fail("no web API key: set AERUN_WEB_API_KEY or VITE_FIREBASE_API_KEY in .env.production");

const rootEmail = process.env.AERUN_ROOT_EMAIL ?? readEnvValue(".env.production", "VITE_ADMIN_EMAIL");
if (!process.env.AERUN_ROOT_UID && !rootEmail) fail("no root identity: set AERUN_ROOT_UID or VITE_ADMIN_EMAIL");

// Access token is used only for the account lookup; the callable itself runs on
// a synthetic root user session, exactly as the browser would.
const serviceAccessToken = async () => {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = signJwt(
    {
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/identitytoolkit",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    },
    key.private_key,
  );

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    fail(`service access token request failed (HTTP ${response.status}): ${body.error_description ?? body.error ?? "unknown"}`);
  }
  return body.access_token;
};

const resolveRootUid = async () => {
  if (process.env.AERUN_ROOT_UID) return process.env.AERUN_ROOT_UID;
  const accessToken = await serviceAccessToken();
  const response = await fetch(`${IDENTITY_BASE}/projects/${project}/accounts:lookup?key=${webApiKey}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: [rootEmail] }),
  });
  const body = await response.json().catch(() => ({}));
  const uid = body.users?.[0]?.localId;
  if (!uid) fail(`root account lookup failed (HTTP ${response.status}): ${body.error?.message ?? "not found"}`);
  return uid;
};

const idTokenForRoot = async (uid) => {
  const now = Math.floor(Date.now() / 1000);
  const customToken = signJwt(
    {
      iss: key.client_email,
      sub: key.client_email,
      aud: CUSTOM_TOKEN_AUDIENCE,
      iat: now,
      exp: now + 3600,
      uid,
    },
    key.private_key,
  );
  const response = await fetch(`${IDENTITY_BASE}/accounts:signInWithCustomToken?key=${webApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.idToken) {
    fail(`custom token exchange failed (HTTP ${response.status}): ${body.error?.message ?? "unknown"}`);
  }
  return body.idToken;
};

const callStrip = async (idToken, cursor, limit) => {
  const payload = {};
  if (cursor) payload.afterUid = cursor;
  if (limit !== undefined) payload.limit = limit;
  const response = await fetch(`https://${region}-${project}.cloudfunctions.net/stripProfileEmails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: payload }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const callStripOrFail = async (idToken, cursor) => {
  const { status, body } = await callStrip(idToken, cursor);
  if (status !== 200 || body.error) {
    fail(`callable rejected the request (HTTP ${status}): ${body.error?.status ?? ""} ${body.error?.message ?? "unknown"}`);
  }
  if (typeof body.result !== "object" || body.result === null) fail("callable returned an unexpected payload");
  return body.result;
};

const uid = await resolveRootUid();
console.log("root uid resolved (never printed); requesting custom token exchange");
const idToken = await idTokenForRoot(uid);

// AERUN_CHECK_ONLY=1 proves the whole path without touching a single document:
// limit=0 is invalid, and the callable validates the payload only after the
// root identity check, so the expected answer is invalid-argument. Any other
// answer means the token is not accepted as root.
if (process.env.AERUN_CHECK_ONLY === "1") {
  const { status, body } = await callStrip(idToken, null, 0);
  const message = body.error?.message ?? "";
  console.log(`auth probe: HTTP ${status} status=${body.error?.status ?? "-"} message="${message}"`);
  if (status === 200) fail("check-only probe received HTTP 200 with limit=0: the callable contract changed, review manually");
  if (status === 401 || status === 403 || /unauthenticated|permission/i.test(message)) {
    fail(`auth probe was rejected: the synthesised root session does not carry root rights (${message})`);
  }
  if (!/limit/i.test(message)) fail(`auth probe returned an unexpected error: ${message}`);
  console.log("RESULT: check-only probe passed - root session accepted, endpoint reachable, nothing was modified");
  process.exit(0);
}

let cursor = null;
let processed = 0;
let stripped = 0;
let batches = 0;
for (; batches < maxBatches; batches += 1) {
  const result = await callStripOrFail(idToken, cursor);
  processed += result.processed ?? 0;
  stripped += result.stripped ?? 0;
  console.log(
    `batch ${batches + 1}: processed=${result.processed} stripped=${result.stripped} done=${result.done} cursor=${result.nextAfterUid ? "set" : "none"}`,
  );
  if (result.done) break;
  cursor = result.nextAfterUid;
  if (!cursor) fail("the callable asked for another batch but returned no cursor");
}
if (batches >= maxBatches) fail(`more than ${maxBatches} batches: stop and inspect the collection`);

console.log(`total this run: processed=${processed} stripped=${stripped}`);

// Idempotence proof: a fresh pass must find nothing left to strip.
const confirmation = await callStripOrFail(idToken, null);
console.log(`confirmation pass: processed=${confirmation.processed} stripped=${confirmation.stripped} done=${confirmation.done}`);
if (confirmation.stripped !== 0) fail("a second pass still stripped emails: investigate before closing the task");

console.log(stripped === 0
  ? "RESULT: nothing to strip - the collection was already clean"
  : `RESULT: ${stripped} public email copies removed; the collection is clean`);
