import { sendApi } from './pocketbase';
import { processDiceRolls } from '../utils/dice';
import { sharedPoll } from './shared-poll';
import { subscribeToRealtimeSignals, canReceiveSignals } from './realtime-signals';

/**
 * Returns a deterministic conversation ID for two users.
 */
export const getConversationId = (uid1, uid2) =>
  [uid1, uid2].sort().join('_');

/**
 * Find the conversation with `theirUid`, or start one.
 *
 * The existing thread is found among `knownConversations` — the list the server
 * already returns for the inbox, whose rows carry `participants`.
 *
 * The previous implementation read the `dm_members` collection straight from the
 * browser to ask the same question. That collection is server-only (every rule is
 * nil), so the read was refused with 403 on every attempt, and the error was
 * swallowed by the surrounding catch. Control therefore always fell through to
 * the create branch below, which meant opening a DM with somebody you had already
 * written to started a brand-new "Conversation started" thread every single time.
 * A 403 that silently becomes a duplicate row is worse than a visible failure,
 * so the lookup now uses data the client is actually allowed to have.
 */
export const getOrCreateConversation = async (myUid, theirUid, myProfile, theirProfile, knownConversations = []) => {
  if (!myUid || !theirUid) return null;

  // The server resolves this rather than the browser.
  //
  // It used to be answered client-side by reading the `dm_members` collection
  // directly. That collection is server-only (every rule is nil), so the read
  // was refused with 403 on every attempt and the error was swallowed by the
  // surrounding catch — control always fell through to the create branch below,
  // so opening a DM with somebody you had already written to started a
  // brand-new "Conversation started" thread every single time. A 403 that
  // silently becomes a duplicate row is worse than a visible failure.
  //
  // The in-memory list is consulted first purely to avoid a round trip on the
  // common case, never as the answer: the inbox listing is paginated, so it
  // stops containing older correspondents once a member has more threads than
  // one page holds, and that would start duplicating threads all over again.
  const known = (knownConversations || []).find(
    (conv) => Array.isArray(conv.participants) && conv.participants.includes(theirUid)
  );
  if (known) return known.id;

  const res = await sendApi(`/api/aerun/conversations/peer/${encodeURIComponent(theirUid)}`);
  if (res?.conversation_id) return res.conversation_id;

  // No thread with this person yet, so start one.
  const title = theirProfile?.nickname || 'Direct Message';
  const created = await sendApi('/api/aerun/dms', {
    method: 'POST',
    body: {
      recipient_ids: [theirUid],
      title,
      text: 'Conversation started'
    }
  });

  return created?.conversation?.id || created?.id || created?.conversation_id;
};

// ── DM list ──────────────────────────────────────────────────────────────────
//
// ONE list read for the whole app. The Navbar badge and the messages page both
// wanted it, each with its own 10s interval and its own realtime channel, so an
// open DM page issued the same `GET /api/aerun/dms` twice on two clocks.
//
// Keyed by account: the cached list must never be handed to a different member
// after a sign-out, and a stale account's loop must not survive the switch.
const dmListPolls = new Map();

export const refreshDmList = (uid) => {
  if (!uid) return;
  dmListPolls.get(uid)?.refresh();
};

export const subscribeToDmList = (uid, callback, errorCallback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }
  const poll = sharedPoll(`dm-list:${uid}`, {
    fetch: async () => {
      const res = await sendApi('/api/aerun/dms');
      return (res?.items || []).map(conv => ({
        id: conv.id,
        ...conv,
        lastTimestamp: conv.last_message_at,
        lastMessage: conv.last_message
      }));
    },
    // Same deal as the thread: realtime first, this interval only as the
    // fallback. A new DM moves the conversation to the top and bumps its unread
    // count, so this list is exactly the kind of state a `dm.post` signal is for.
    intervalMs: 10000,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToDmList err]', err),
    realtime: canReceiveSignals()
      ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
        () => onDelivered(),
        () => onDead(),
          onStateChange,
      )
      : null,
  });

  dmListPolls.set(uid, poll);

  // The error travels WITH the last good list rather than replacing it, so a
  // failed refresh leaves the conversation list on screen.
  return poll.subscribe((items, err) => {
    if (err && errorCallback) errorCallback(err);
    callback(items);
  });
};

// ── Unread counters ──────────────────────────────────────────────────────────
//
// ONE counters read, and it now carries the topic badge too.
//
// `unread_topics` used to be computed in the browser from a `topics?limit=50`
// list that the main-page projection carried for exactly this purpose: fifty whole
// topic records to render one integer, capped so that a member with 60 unread was
// told 50, and derived from a localStorage read map so the desktop and the phone
// disagreed about the same account. The server already counts notifications and
// DMs here, so the topic count belongs here too — the badge costs no request it
// was not already making, and it is the only number of the three that can no
// longer be capped by a page size.
//
// The shared resource name is unchanged, and it is scoped by account: the counters
// are caller-scoped, so AuthProvider (dmUnread) and TitleProvider (tab title) are
// reading the SAME resource and the second subscriber costs nothing.
const unreadCountsPolls = new Map();

export const subscribeToUnreadCounts = (uid, callback) => {
  if (!uid) {
    callback({ total: 0, conversations: {}, topics: 0, notifications: 0 });
    return () => {};
  }
  const poll = sharedPoll(`dm-unread:${uid}`, {
    fetch: async () => {
      const res = await sendApi('/api/aerun/me/unread-counts');
      return {
        total: res?.total_unread_messages || res?.unread_conversations || 0,
        conversations: {},
        // A missing key reads as 0 rather than NaN: an older backend that predates
        // the field should show no badge, not break the navbar's arithmetic.
        topics: Number(res?.unread_topics) || 0,
        // The UNREAD NOTIFICATION COUNT, which this response already carried and
        // this mapping used to drop on the floor.
        //
        // Both badges that show it — the navbar bell and the tab title — used to
        // answer it by fetching `GET /me/notifications?limit=100` and counting
        // `!n.read` in the browser, on every page of the forum. That is a row list
        // carried for a number, the same defect `latestTopics` was on the
        // main-page projection, and it was capped while it was at it: a member with
        // 150 unread notifications was told 100, because the badge could only see
        // the newest hundred rows. The server counts every unread, unread-not-
        // archived row, so the badge reads the count and the LIST is fetched only
        // where rows are actually rendered.
        notifications: Number(res?.unread_notifications) || 0
      };
    },
    intervalMs: 15000,
    initialValue: { total: 0, conversations: {}, topics: 0, notifications: 0 },
    // The comment that used to stand here said this resource deliberately had no
    // realtime channel, on the grounds that the counters only move as a side
    // effect of a message and "that message already wakes the DM list poll and
    // the notification poll". That stopped being true when those two moved onto
    // signals: in a quiet forum none of them delivers, so all three quietly fell
    // back to polling and this one — at 15s, forever — became the most
    // persistent request in the app.
    //
    // The counters move on exactly the two topics that already publish signals
    // (`dm.post` and `notification.new`), so this is the same re-read the other
    // two do.
    realtime: canReceiveSignals()
      ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
        () => onDelivered(),
        () => onDead(),
        // Without this a quiet DM thread abandons a perfectly healthy stream
        // after the grace window and polls for the rest of the session.
        onStateChange,
      )
      : null,
  });
  if (uid) unreadCountsPolls.set(uid, poll);

  const unsubscribe = poll.subscribe((counts) => callback(counts));
  return () => {
    unsubscribe();
    if (poll !== unreadCountsPolls.get(uid)) return;
    // sharedPoll keeps the loop alive while ANY subscriber remains (AuthProvider
    // + TitleProvider share it), so only drop the handle when nobody is left.
    // There is no subscriber count exposed, so keep the handle — a stale entry
    // only costs a map slot, while dropping it early would lose the refresh.
  };
};

// refreshUnreadCounts re-reads /me/unread-counts WITHOUT waiting for the 15s
// tick. Called after the member marks topic(s) read: the server state already
// moved, but the badge (navbar + tab title + /new-replies tab) renders the
// last POLLED value, so without this it stays stale until the next interval.
export const refreshUnreadCounts = (uid) => {
  try {
    unreadCountsPolls.get(uid)?.refresh();
  } catch {
    // A missed refresh only delays the badge to the next tick — never fail a
    // navigation or a mark-read for it.
  }
};

// subscribeToDmUnread keeps its name at the call sites that only read DMs.
export const subscribeToDmUnread = subscribeToUnreadCounts;

/**
 * One wire shape → one client shape, for EVERY DM message the app receives.
 *
 * The server speaks `sender_id` / `created`; the thread renders `sender_uid` /
 * `timestamp` and decides "is this mine" and "when was this" off those names.
 * That translation used to be written out inline at each read site, which is
 * exactly how the mutation paths ended up returning something the thread could
 * not drop into its state: editing and deleting gave back the raw payload with
 * no `sender_uid` and no `timestamp`, so an applied row would have rendered as
 * somebody else's message with no date.
 *
 * It is also what makes a tombstone apply cleanly. A deleted message comes back
 * WITHOUT a `text` key at all, so a naive `{...msg}` would keep the old text —
 * the merge has to be a REPLACE of the row, which is only safe because both
 * sides went through this one function.
 */
const normalizeDmMessage = (m) => ({
  id: m.id,
  ...m,
  sender_uid: m.sender_id,
  timestamp: m.created,
});

/**
 * Fetches the page of messages immediately older than `beforeSequence`.
 *
 * This used to accept a timestamp, ignore it entirely, and re-issue the same
 * unbounded `?limit=N` request the poll already made — so it returned the same
 * page every time, the merge by id changed nothing, and the button appeared
 * dead. Walking backwards needs a real cursor, and `sequence` is the stable one:
 * it is dense per conversation and unaffected by two messages sharing a
 * timestamp.
 */
export const fetchOlderDmMessages = async (conversationId, beforeSequence, batchSize = 15) => {
  if (!conversationId || !beforeSequence) return [];
  try {
    const res = await sendApi(
      `/api/aerun/dms/${conversationId}/messages?limit=${batchSize}&before_sequence=${encodeURIComponent(beforeSequence)}`
    );
    return (res?.items || []).map(normalizeDmMessage);
  } catch (err) {
    console.error('[fetchOlderDmMessages err]', err);
    return [];
  }
};

/**
 * Subscribe to messages in a conversation.
 *
 * This was the LAST resource still polling on a 5-second timer, which made an
 * open thread cost twelve list reads a minute — the most expensive screen on the
 * forum to leave open, and the one whose whole purpose is showing that somebody
 * else is typing.
 *
 * It now rides the signal transport, like notifications do. `dm.post` is already
 * published on every send (dms.go, addressed to the recipient only), so the
 * thread learns there is something new and re-reads through /api/aerun.
 *
 * The topic is deliberately NOT filtered in the browser. Telling "this signal is
 * mine" from "that one is" on the client would mean trusting the payload, and the
 * payload is an id precisely because it is not to be trusted; one coalesced
 * re-read per burst is cheap, and the server decides what the member may see.
 */
// The live poll behind each open conversation, so a change made IN this thread
// can force one immediate read instead of waiting for a background tick.
//
// This exists because the fallback interval is not a guarantee. shared-poll
// REMOVES the timer the first time any realtime signal is delivered, and a
// member's own edit and delete publish their signal to the other participant
// only — so the author had no delivery path at all: no timer, no signal, and a
// thread still showing the old words. The mutation response settles the bubble
// (see editDmMessage/deleteDmMessage) and this makes the list, the counters and
// anything the response does not carry converge now rather than eventually.
const dmMessagePolls = new Map();

export const refreshDmMessages = (conversationId) => {
  if (!conversationId) return;
  dmMessagePolls.get(conversationId)?.refresh();
};

export const subscribeToDmMessages = (conversationId, limitCount, callback, errorCallback, onHasMore) => {
  if (!conversationId) {
    callback([]);
    return () => {};
  }

  // Keyed per conversation so opening a second thread does not inherit the first
  // one's messages, and so a closed thread releases its own loop.
  //
  // The fetch returns `has_more` alongside the rows because the thread view needs
  // it: without it the "load older messages" button is a guess, and a guessed
  // button sits there doing nothing on a conversation that has no history left
  // to load.
  const poll = sharedPoll(`dm-messages:${conversationId}:${limitCount}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/dms/${conversationId}/messages?limit=${limitCount}`);
      return {
        items: (res?.items || []).map(normalizeDmMessage),
        // This flag describes the NEWEST page. It is the right answer for "is
        // there anything older than what I am looking at" only while the client
        // has not walked backwards yet; once it has, the client owns the flag.
        hasMore: !!res?.has_more,
      };
    },
    // Kept as the FALLBACK, not the primary path: shared-poll drops the timer the
    // moment a signal actually arrives and restores it if the stream goes quiet.
    //
    // 30s, not the 5s this ran at before realtime existed. That 5s was chosen
    // when a 5-second poll was the ONLY way to see a reply — which is not true
    // any more, and shared-poll treats a stream that never delivers exactly like
    // a broken one. So a CONVERSATION NOBODY IS TYPING IN, which is the normal
    // state of a DM thread, fell back to reading the newest 15 messages twelve
    // times a minute for nothing. 30s is the price of a stream that stays
    // silent: cheap enough to be unnoticeable while typing (a real message
    // arrives by signal, instantly), bounded enough not to hammer the server
    // while the thread just sits there.
    intervalMs: 30000,
    initialValue: { items: [], hasMore: false },
    onError: (err) => console.error('[subscribeToDmMessages err]', err),
    realtime: canReceiveSignals()
      ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
        () => onDelivered(),
        () => onDead(),
        // Without this an open conversation nobody is typing in gives up on
        // realtime after ten seconds of silence — the reported failure.
        onStateChange,
      )
      : null,
  });

  dmMessagePolls.set(conversationId, poll);

  return poll.subscribe((payload, err) => {
    if (err && errorCallback) errorCallback(err);
    const data = payload || { items: [], hasMore: false };
    if (onHasMore) onHasMore(data.hasMore);
    callback(data.items);
  });
};

/**
 * Send a message in a conversation.
 */
// `senderUid` / `recipientUid` are no longer read: the backend derives both
// from the auth token and refuses to let a client post as somebody else.
export const sendDmMessage = async (conversationId, _senderUid, text, _recipientUid, idempotencyKey) => {
  if (!conversationId || !text) return;
  // Sent alongside the text for the same reason as on the forum: without the
  // map the `[roll=<id>]` tag in the body is an unresolved pointer, and a DM
  // rendered the raw tag on both sides of the conversation.
  const { content: processedContent, rolls } = processDiceRolls(text);

  return await sendApi(`/api/aerun/dms/${conversationId}/messages`, {
    method: 'POST',
    // A stable key per logical send. sendApi otherwise mints a fresh random one
    // per call, so a double-click that escapes the in-flight latch is two posts.
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: {
      text: processedContent.trim(),
      ...(rolls && Object.keys(rolls).length > 0 ? { rolls } : {})
    }
  });
};

// ── The correspondent ──────────────────────────────────────────────────────────
//
// The MINIMUM a conversation needs about the person on the other side: a
// nickname, an avatar, and whether the account may still be written to.
//
// It used to be `subscribeToUser`, which is the profile PAGE — bio, birthday,
// occupation, contacts, counters, and the member's `settings` object. Two
// effects in DirectMessages called it (one for the header, one for the composer
// lock), so opening a thread issued the same heavy read twice, and the payload
// carried a stranger's private preferences to a component that renders neither.
//
// The endpoint behind it is /api/aerun/peers/{id}, which is that subset and
// nothing more. Shared, like every other read here, so the header and the lock
// cost ONE request between them instead of one each.
//
// It is a shared resource but NOT a realtime one, and the interval is long: a
// nickname changes when somebody renames themselves, not on a 10-second clock,
// and a conversation left open all evening must not cost a request every ten
// seconds to re-read four fields. It re-reads when a DM signal arrives, because
// a signal is proof something about this account moved.
export const subscribeToPeerCard = (uid, callback, errorCallback) => {
  if (!uid) {
    callback(null);
    return () => {};
  }

  const poll = sharedPoll(`dm-peer:${uid}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/peers/${encodeURIComponent(uid)}`);
      return {
        uid: res?.id || uid,
        nickname: res?.nickname || '',
        avatar: res?.avatar || '',
        avatar_url: res?.avatar_url || '',
        // The axis that decides the composer. `banned` is an ACCOUNT STATUS, not
        // a role — normalizeUserProfile says so in as many words, and the old
        // check here compared it against `role_id`, which is a different column
        // and never holds that value. So the lock silently never engaged.
        status: res?.status || 'active',
      };
    },
    intervalMs: 120000,
    initialValue: null,
    onError: (err) => console.warn('[subscribeToPeerCard err]', err),
    realtime: canReceiveSignals()
      ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
          () => onDelivered(),
          () => onDead(),
          // Without this the peer card keeps the old "first event proves the
          // stream" rule, and an idle conversation abandons a healthy stream.
          onStateChange,
        )
      : null,
  });

  return poll.subscribe((card, err) => {
    if (err && errorCallback) errorCallback(err);
    callback(card);
  });
};

/**
 * Edit a message you sent.
 *
 * Sender-only on the server: the recipient cannot rewrite what somebody else
 * wrote, and staff authority over the forum does not extend into private mail.
 * A tombstone answers 409 — there is no text left to correct, and accepting an
 * edit would quietly resurrect a message the sender took back.
 *
 * Returns the corrected row, ready to drop into thread state. The sender is not
 * signalled about their own edit (the signal is addressed to the other side
 * only), so this response is the ONLY thing that can repaint the bubble — the
 * alternative was a success toast over unchanged text.
 */
export const editDmMessage = async (messageId, text) => {
  if (!messageId || !text) return null;
  const { content: processedContent } = processDiceRolls(text);
  const res = await sendApi(`/api/aerun/dm-messages/${messageId}`, {
    method: 'PATCH',
    body: { text: processedContent.trim() }
  });
  return res?.message ? normalizeDmMessage(res.message) : null;
};

/**
 * Delete a message you sent, leaving a TOMBSTONE.
 *
 * The row survives and keeps its place in the thread, so the other participant
 * still sees that something was said and removed — the opposite of the forum,
 * where a deleted post is simply gone. `messages_count` does not move.
 *
 * Returns the tombstone row. Same reasoning as the edit: the author gets no
 * realtime signal for a change they made themselves, so the response is the
 * only thing that can replace the bubble on screen.
 */
export const deleteDmMessage = async (messageId) => {
  if (!messageId) return null;
  const res = await sendApi(`/api/aerun/dm-messages/${messageId}`, {
    method: 'DELETE'
  });
  return res?.message ? normalizeDmMessage(res.message) : null;
};

/**
 * Reset unread count for current user in conversation.
 */
export const markDmRead = async (conversationId, _uid) => {
  if (!conversationId) return;
  try {
    await sendApi(`/api/aerun/dms/${conversationId}/read`, {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[markDmRead err]', err);
  }
};

/**
 * Deletes / clears the conversation history for current user.
 *
 * Throws on failure: the caller decides what the member sees, and a delete
 * that silently did nothing is how a row survives its own confirmation.
 */
export const deleteConversation = async (conversationId, _uid) => {
  if (!conversationId) return;
  await sendApi(`/api/aerun/dms/${conversationId}/clear`, {
    method: 'POST'
  });
};
