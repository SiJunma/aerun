// topic-delete.js — the CLIENT's view of "may this topic be removed, and what
// does the server say when it may not".
//
// WHY THIS IS A MODULE AND NOT AN INLINE CONSTANT IN THE PAGE. The decision
// that produced the dead end lived inside TopicPage's render body, where no
// test could reach it: the page is a 4 000-line React component, so the only
// way to "test" it was to grep its text — and a grep cannot tell a rule that
// works from a rule that was merely typed. The rule here is therefore plain
// data in, boolean out, and `scripts/check-topic-delete-affordance.mjs`
// EXECUTES it.
//
// THE SERVER IS THE AUTHORITY, AND THIS MIRRORS IT — NOTHING MORE. The
// Go handler (`backend/internal/platform/pocketbase/forum_topics.go`,
// deleteTopicHandler) decides in this order:
//
//  1. the caller is not the topic's author AND holds no `delete_others_topics`
//     → 403;
//  2. the caller IS the author, the thread holds replies from other members,
//     and the caller holds no `delete_own_topic_with_replies` → 409;
//  3. otherwise → 200.
//
// So the client only has to know whether the ACTION EXISTS at all, and it must
// never be stricter than the server — a client that hides a working action
// reproduces the very dead end this module was written to remove. The author
// is therefore always offered the action (the server decides 200 vs 409), and
// a holder of `delete_others_topics` is offered it for anybody's topic.
//
// Note that the server does NOT consult `delete_self_topic` on this path: an
// author may always retract a thread that holds nothing but their own opening
// post, with no permission key at all (see the comment on `delete_others_topics`
// in deleteTopicHandler). Gating on that key here would hide an action the
// server accepts, which is the bug this file exists to prevent.
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * The account id that opened the topic, or null when there is none.
 *
 * The topic page is driven by GET /topics/{id}/stats, whose payload carries
 * the FLAT `author_id`; the full topic payload carries the nested `author`
 * DTO. Both are read, so the check works whichever shape arrived. A guest
 * topic has neither (its author_id is empty), which is why the result is
 * null rather than an empty string — a guest cannot own a topic, and an
 * empty id must never compare equal to an account id.
 *
 * @param {object|null} topic the topic as the page holds it
 * @returns {string|null} the owner's account id, or null
 */
export const resolveTopicOwnerId = (topic) => {
  if (!topic) return null;
  const nested = topic.author?.user_id;
  if (nested) return nested;
  const flat = topic.author_id;
  return flat || null;
};

/**
 * Whether the topic delete action may be OFFERED to this viewer.
 *
 * This is a rendering decision, not an authorisation one: the server
 * re-checks everything and answers 403/409 on its own. Offering the action
 * and reporting the refusal is honest; hiding it (or pointing the user at a
 * menu that does not exist for them) is the dead end.
 *
 * @param {object} params
 * @param {object|null} params.topic the topic as the page holds it
 * @param {object|null} params.user the signed-in account, if any
 * @param {(perm: string) => boolean} params.hasPermission the caller's permission probe
 * @returns {boolean} true when the action exists for this viewer
 */
export const canDeleteTopic = ({ topic, user, hasPermission }) => {
  // No topic, no action. The page renders a skeleton while the topic is
  // loading, so this is not a state a user can reach — but a rule that
  // answers "yes, you may delete it" about a topic that does not exist is
  // answering a question nobody asked.
  if (!topic) return false;
  const ownerId = resolveTopicOwnerId(topic);
  const isOwner = !!user?.uid && !!ownerId && ownerId === user.uid;
  if (isOwner) return true;
  return typeof hasPermission === 'function'
    && !!hasPermission(PERMISSIONS.DELETE_OTHERS_TOPICS);
};

/**
 * The wording for a refused topic delete.
 *
 * The server answers 409 when the thread holds replies from other members and
 * the caller lacks `delete_own_topic_with_replies`. That is a POLICY answer,
 * not a failure, so it gets its own text instead of the raw English sentence
 * the API sends.
 *
 * @param {{status?: number, message?: string}|null} err the rejected request
 * @param {string} lang the active language code
 * @returns {string} a message that names the reason
 */
export const topicDeleteErrorText = (err, lang) => {
  if (err?.status === 409) {
    return lang === 'ru'
      ? 'В теме есть ответы других участников. Удалить тему вместе с их сообщениями может только администратор.'
      : 'This topic has replies from other members. Only an administrator can remove it with their posts.';
  }
  if (err?.status === 403) {
    return lang === 'ru'
      ? 'Недостаточно прав для удаления этой темы.'
      : 'You are not allowed to delete this topic.';
  }
  return err?.message || (lang === 'ru' ? 'Не удалось удалить тему' : 'Failed to delete the topic');
};