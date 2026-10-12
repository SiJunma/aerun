/**
 * The rescue for a reply the forum never sent.
 *
 * THE INCIDENT (russff, reported three times as variants). A member writes a
 * reply, hits send, and the server refuses — the topic reached its post limit
 * and closed, or a moderator locked it, or it was deleted while the form was
 * open. The form dies and the text is GONE: uncopyable, because it only ever
 * lived in React state and in ONE localStorage key that is read back
 * exclusively by that same topic's page. A locked topic has no composer to hold
 * it, and a deleted topic has no page to read it back on.
 *
 * WHAT THIS IS NOT. Not the server-side draft of `drafts.go`, and not DRAFT_KEY.
 * A draft is text the member CHOSE to save and can publish again; this is text
 * the server WOULD NOT TAKE. The deliverable is that the member can read and
 * copy it. Restoring it into an unrelated topic's form is explicitly out of
 * scope: that would post one member's words under another thread's context.
 *
 * STORAGE. One key per (topic, account), deliberately NOT cleared on submit the
 * way DRAFT_KEY's writer would suggest, because its job is to outlive the page:
 *
 *     aerun_unsent_reply_${topicId}_${uid}  ->  { content, saved_at, reason }
 *
 * The uid is a correctness requirement, not tidiness: without it, switching
 * accounts on a shared browser would offer the previous member's text for
 * deletion. `reason` drives the modal's wording and nothing else.
 *
 * LIFECYCLE — the part that decides whether this is a feature or a nuisance.
 * A key is cleared in exactly TWO situations: the reply is successfully sent
 * (the same instant DRAFT_KEY is cleared), or the member presses the modal's
 * delete button. There is NO age-based eviction, by explicit owner ruling
 * (2026-10-11) — a safety net that silently discards what it saved is not a
 * safety net.
 *
 * GUESTS ARE NOT SERVED. A guest has no uid, and a `guest` fallback would pool
 * every signed-out visitor's text into one shared bucket on a shared machine.
 * A guest's reply still survives in DRAFT_KEY on the topic's own page, exactly
 * as before.
 */

export const UNSENT_REPLY_PREFIX = 'aerun_unsent_reply_';

/** The topic closed under the member (post limit reached, or a moderator lock). */
export const REASON_TOPIC_CLOSED = 'topic_closed';
/** The topic vanished under the member (deleted, hidden or moved). */
export const REASON_TOPIC_UNAVAILABLE = 'topic_unavailable';

/**
 * Opens localStorage, or reports that it cannot be opened.
 *
 * Guarded on ACCESS, not just on use: private-mode Safari and hardened browser
 * configs throw when the property is merely READ, so a bare `localStorage`
 * reference at module scope would break every importer of this module.
 */
const openStore = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export const unsentReplyKey = (topicId, uid) => `${UNSENT_REPLY_PREFIX}${topicId}_${uid}`;

/**
 * Whether a failure means "this topic is gone", as opposed to "this read failed".
 *
 * WHY THIS NEEDS TO EXIST AS A PREDICATE. `TopicPage` keeps `accessError` as a
 * STRING (`err.message`), because that is what it renders in the access-denied
 * card. The distinction the rescue needs — did the server answer 404/403, or did
 * the request simply not complete — is exactly what flattening to a message
 * destroys, and getting it wrong is not cosmetic: the stats loop runs every 15s
 * for as long as the page is open, so one timeout or one 500 there would strand a
 * live topic's reply under a modal telling the member it can never be delivered.
 *
 * So the classification is taken from the status the API layer still carries,
 * never from the wording. `err.status` is what `sendApi` sets
 * (`src/api/pocketbase.js`); `err.code` covers the case where the status did not
 * survive the hop but the backend's `kind` did — the Go error contract spells
 * those `not_found` and `forbidden` (`backend/internal/platform/pocketbase/errors.go`),
 * never with a hyphen. Anything else — a timeout, a 5xx, a dropped connection —
 * is answered false: the read failed, the topic did not, and DRAFT_KEY still
 * holds the text on the page it was written on.
 *
 * A STRING is refused outright, and that is deliberate. `TopicPage` renders
 * `accessError`, a flattened `err.message`, in its access-denied card — by the
 * time a value has been reduced to prose it has lost the status this predicate
 * exists to read, and a message like "Request timed out" must never be
 * reinterpreted as "the topic is gone". Callers therefore pass the ORIGINAL
 * error object alongside the string they render, not the string itself.
 *
 * @param {any} err the error as delivered by the api layer
 * @returns {boolean} true only for a topic the server will not serve
 */
export const isTopicUnavailableError = (err) => {
  if (!err) return false;
  if (typeof err === 'string') return false;
  return err.status === 404 || err.status === 403
    || err.code === 'not_found' || err.code === 'forbidden';
};


/**
 * In-tab change bus.
 *
 * `window.addEventListener('storage')` would be the obvious mechanism and is
 * the wrong one: it fires only in OTHER documents, so a rescue written by
 * TopicPage would never reach the notice mounted in the same tab — which is the
 * only case that actually happens, and the one that matters most, because for
 * `topic_unavailable` the topic page is on its way out.
 *
 * This is a plain listener set, not a timer and not a shared poll: the write
 * and the notification are one user action, so there is nothing to coalesce and
 * no interval to own.
 */
const listeners = new Set();

const notify = (detail) => {
  listeners.forEach((fn) => {
    try {
      fn(detail);
    } catch (err) {
      console.warn('[unsent-replies] listener failed', err);
    }
  });
};

/** Subscribes to every rescue write and clear. Returns an unsubscribe. */
export const subscribeToUnsentReplies = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Reads and validates one entry, DELETING anything malformed.
 *
 * A corrupt or hand-edited key would otherwise make the notice promise a modal
 * it cannot fill, forever, with no way for the member to clear it. Removing it
 * leaves a working page and a rescue the member can write again.
 */
const readEntry = (key) => {
  const store = openStore();
  if (!store) return null;

  let raw = null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeItem(key);
    return null;
  }

  const content = typeof parsed?.content === 'string' ? parsed.content : '';
  if (!content.trim()) {
    removeItem(key);
    return null;
  }

  return {
    content,
    saved_at: parsed.saved_at || null,
    reason: normaliseReason(parsed.reason),
  };
};

/**
 * Writes the rescue. Returns the stored entry, or null when there was nothing
 * worth rescuing.
 *
 * `uid` is REQUIRED with no `guest` fallback, on purpose — see the note at the
 * top of the file. Callers gate on `user?.uid` before they get here.
 */
export const saveUnsentReply = ({ topicId, uid, content, reason }) => {
  if (!topicId || !uid) return null;
  if (typeof content !== 'string' || !content.trim()) return null;

  const entry = {
    content,
    saved_at: new Date().toISOString(),
    reason: normaliseReason(reason),
  };

  const store = openStore();
  if (!store) return null;
  try {
    store.setItem(unsentReplyKey(topicId, uid), JSON.stringify(entry));
  } catch (err) {
    // Quota is the realistic failure. Loud on purpose: a member whose rescue
    // silently did not happen has no other signal that their text was lost.
    console.warn('[unsent-replies] could not save the rescue', err);
    return null;
  }

  notify({ topicId, uid, action: 'saved', entry });
  return entry;
};

export const readUnsentReply = (topicId, uid) => {
  if (!topicId || !uid) return null;
  return readEntry(unsentReplyKey(topicId, uid));
};

/**
 * Whether a rescue still EXISTS for this (topic, member) — no parse, no shape.
 *
 * This is deliberately not `!!readUnsentReply(...)`: readEntry self-heals by
 * DELETING malformed entries, and the one caller (TopicPage's staleness check)
 * runs after a submit cleared the key. Parsing there would resurrect a
 * half-written row into a "still rescued" answer. Existence is the question
 * being asked, so existence is what is checked.
 */
export const hasUnsentReply = (topicId, uid) => {
  if (!topicId || !uid) return false;
  const store = openStore();
  if (!store) return false;
  try {
    return store.getItem(unsentReplyKey(topicId, uid)) !== null;
  } catch {
    return false;
  }
};

/**
 * Removes a rescue. Called ONLY by a successful submit and by the modal's
 * delete button — the two things the lifecycle at the top of this file allows.
 */
export const clearUnsentReply = (topicId, uid) => {
  if (!topicId || !uid) return;
  removeItem(unsentReplyKey(topicId, uid));
  notify({ topicId, uid, action: 'cleared' });
};

/**
 * Every rescue this member has, newest first — what the global notice reads on
 * mount and on every change.
 *
 * Keys are scanned with `key(i)`, NOT `Object.keys(localStorage)`: a Storage
 * object exposes its entries as indexed properties, so `Object.keys` returns an
 * empty array and the notice would show nothing at all, forever, while every
 * individual read worked perfectly. That is the failure mode this comment
 * exists to prevent.
 *
 * The uid is matched on the SUFFIX, so a topic id containing an underscore
 * cannot be mistaken for another member's row, and the topic id is recovered by
 * slicing off both the prefix and that suffix.
 */
export const listUnsentReplies = (uid) => {
  const store = openStore();
  if (!store || !uid) return [];

  const mine = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(UNSENT_REPLY_PREFIX)) continue;
      const suffix = `_${uid}`;
      if (!key.endsWith(suffix)) continue;
      const topicId = key.slice(UNSENT_REPLY_PREFIX.length, key.length - suffix.length);
      if (!topicId) continue;
      const entry = readEntry(key);
      if (entry) mine.push({ ...entry, topicId });
    }
  } catch (err) {
    console.warn('[unsent-replies] could not list rescues', err);
    return [];
  }

  mine.sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')));
  return mine;
};

// Only these two reasons are ever stored. An unknown value is normalised to
// CLOSED rather than kept: the wording has to name something, and inventing a
// third case would describe a state the server never reported.
const normaliseReason = (reason) =>
  reason === REASON_TOPIC_UNAVAILABLE ? REASON_TOPIC_UNAVAILABLE : REASON_TOPIC_CLOSED;

const removeItem = (key) => {
  const store = openStore();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // A store that refuses a removal also refused the write. Nothing to undo.
  }
};
