import { sendVisitTelemetry } from '../api/analytics';

/**
 * Telemetry Session Manager
 *
 * Implements client-side visit sessionization with a 30-minute inactivity window:
 * - Session ID stored in sessionStorage (per tab / session)
 * - If last action was > 30 minutes ago, generates a fresh session ID
 * - Dispatches visit event on first app load, path transitions, and sign-in transitions
 */

const SESSION_KEY = 'aerun:session:id';
const LAST_ACTIVE_KEY = 'aerun:session:last_active';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 's_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

/**
 * Returns current active session ID or creates a new one if timed out.
 */
export function getOrCreateSessionId() {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return generateUUID();
  }

  const now = Date.now();
  const existingId = sessionStorage.getItem(SESSION_KEY);
  const lastActiveStr = sessionStorage.getItem(LAST_ACTIVE_KEY);
  const lastActive = lastActiveStr ? parseInt(lastActiveStr, 10) : 0;

  if (existingId && lastActive && now - lastActive < SESSION_TIMEOUT_MS) {
    try {
      sessionStorage.setItem(LAST_ACTIVE_KEY, String(now));
    } catch {
      // Ignore storage quota errors
    }
    return existingId;
  }

  const newId = generateUUID();
  try {
    sessionStorage.setItem(SESSION_KEY, newId);
    sessionStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch {
    // Ignore storage quota errors in private browsing
  }
  return newId;
}

/**
 * Touches the current session to keep it alive without re-sending telemetry.
 */
export function touchSession() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    sessionStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
  } catch {
    // Ignore storage quota
  }
}

let lastSentPath = null;
let lastSentUserId = null;
let lastSentTime = 0;

/**
 * Sends a visit telemetry ping to the backend.
 * Protected against duplicate ping spam within 5 seconds on the same (path, userId).
 */
export async function sendTelemetryVisit(options = {}) {
  if (typeof window === 'undefined') return;

  const entryPath = options.entryPath || window.location.pathname || '/';
  const userId = options.userId || '';
  const referrer = options.referrer || document.referrer || '';
  const now = Date.now();

  if (lastSentPath === entryPath && lastSentUserId === userId && now - lastSentTime < 5000) {
    return;
  }

  const sessionId = getOrCreateSessionId();
  let guestId = '';
  try {
    guestId = localStorage.getItem('aerun:guest:guest_id') || '';
  } catch {
    // ignore
  }

  lastSentPath = entryPath;
  lastSentUserId = userId;
  lastSentTime = now;

  try {
    await sendVisitTelemetry({
      session_id: sessionId,
      guest_id: guestId,
      entry_path: entryPath,
      referrer,
    });
  } catch {
    // Silently ignore telemetry errors to never degrade user browsing experience
  }
}
