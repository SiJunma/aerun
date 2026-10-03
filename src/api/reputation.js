// Every read and write here goes through the command layer.
//
// `pb` is deliberately NOT imported: the last thing this module did with it was
// read `reputation_votes` directly from the browser, which that collection's nil
// browser rules refuse with 403. A file that still reached for the SDK would be
// an invitation to do it again.
import { sendApi } from './pocketbase';

/**
 * voteOnPost
 * Allows a user to vote on a specific post.
 */
export const voteOnPost = async (voterUid, targetUid, postId, topicId, value, comment, _topicTitle, _postNumber, _voterNickname = 'User') => {
  if (!targetUid) throw new Error('Cannot vote on guest posts.');
  if (voterUid === targetUid) throw new Error('You cannot vote for yourself.');

  return await sendApi(`/api/aerun/posts/${postId}/vote`, {
    method: 'POST',
    body: {
      value: Number(value),
      comment: comment || ''
    }
  });
};

/**
 * getVotesInTopic
 * Fetches all votes cast by a specific user in a specific topic.
 *
 * This used to call `pb.collection('reputation_votes').getFullList(...)` from
 * the BROWSER. `reputation_votes` is server-only — migration 1766300000 gives it
 * nil browser rules — so every call returned `403 Only superusers can perform
 * this action`. The catch block swallowed it and returned `{}`, which is why the
 * only visible symptom was a console full of errors and every upvote arrow
 * rendering as un-voted even after the member had voted. Reading your own votes
 * through /me/votes (listMyVotesHandler) cannot 403, because the server looks
 * them up for the authenticated caller.
 */
export const getVotesInTopic = async (voterUid, topicId) => {
  if (!voterUid || !topicId) return {};
  try {
    const res = await sendApi(`/api/aerun/me/votes?topic_id=${encodeURIComponent(topicId)}`);
    const votes = {};
    (res?.items || []).forEach(r => {
      if (r.post_id) {
        votes[r.post_id] = {
          id: r.id,
          ...r
        };
      }
    });
    return votes;
  } catch (err) {
    console.warn('[getVotesInTopic]', err);
    return {};
  }
};

/**
 * voteOnProfile
 * Allows a user to vote on another's profile with a comment.
 */
export const voteOnProfile = async (voterUid, targetUid, value, comment, _voterNickname = 'User') => {
  if (voterUid === targetUid) throw new Error('You cannot vote for yourself.');

  return await sendApi(`/api/aerun/users/${targetUid}/vote`, {
    method: 'POST',
    body: {
      value: Number(value),
      comment: comment || ''
    }
  });
};

/**
 * getProfileVote
 * Checks if a user has already voted for a specific profile.
 *
 * Server-side for the same reason as getVotesInTopic: `reputation_votes` has nil
 * browser rules, so the old `pb.collection('reputation_votes').getFirstListItem`
 * could only ever 403. /me/votes returns the caller's own ballots, and a profile
 * vote is the one with an empty post_id.
 */
export const getProfileVote = async (voterUid, targetUid) => {
  if (!voterUid || !targetUid) return null;
  try {
    const res = await sendApi('/api/aerun/me/votes');
    const record = (res?.items || []).find(
      r => !r.post_id && r.target_id === targetUid
    );
    return record ? { id: record.id, ...record } : null;
  } catch {
    return null;
  }
};

/**
 * Edit the comment on a reputation vote you cast.
 *
 * The previous version wrote `pb.collection('reputation_votes').update(...)`
 * for a PROFILE vote — and that collection is locked to the server
 * (lockBrowserRules in migration 1766300000), so the write always failed. It
 * was swallowed by a try/catch that returned undefined, and ProfilePage showed
 * "Reputation comment updated" anyway: a success message for a write that never
 * happened.
 *
 * Both kinds of vote now go through the command layer, which UPDATES the
 * existing vote rather than creating a second one — `voteUserHandler` looks up
 * the voter's existing vote and rewrites its value and comment, so re-sending
 * the current value with a new comment is an edit and not a second vote.
 *
 * @param {{id: string, post_id?: string, target_id?: string, value?: number}} vote
 * @param {string} newComment
 */
export const updateReputationComment = async (vote, newComment = '') => {
  if (!vote || !vote.id) return null;
  const text = newComment || '';

  // A vote on a post: the route knows the post from the URL.
  if (vote.post_id) {
    return await sendApi(`/api/aerun/posts/${vote.post_id}/vote`, {
      method: 'POST',
      body: { value: vote.value, comment: text }
    });
  }

  // A vote on a profile. target_id and value must both travel, or the server
  // would validate an empty value and reject the request.
  if (vote.target_id) {
    return await sendApi(`/api/aerun/users/${vote.target_id}/vote`, {
      method: 'POST',
      body: { value: vote.value, comment: text }
    });
  }

  throw new Error('updateReputationComment needs a post_id or target_id');
};

/**
 * fetchReputationLogs
 * Fetches reputation changes for a user securely through backend API.
 */
export const fetchReputationLogs = async (uid, _page = 1, pageSize = 20, _seekLogId = null) => {
  if (!uid) return { logs: [], total: 0, hidden: false };
  try {
    const res = await sendApi(`/api/aerun/users/${uid}/reputation?limit=${pageSize}`);
    return {
      logs: res?.items || [],
      total: res?.total || (res?.items || []).length,
      hidden: !!res?.hidden
    };
  } catch (err) {
    console.warn('[fetchReputationLogs]', err);
    return { logs: [], total: 0, hidden: false };
  }
};

/**
 * fetchPostVoters
 * Fetches the list of users who voted on a specific post.
 */
export const fetchPostVoters = async (postId, limit = 50) => {
  if (!postId) return { voters: [], total: 0 };
  try {
    const res = await sendApi(`/api/aerun/posts/${postId}/voters?limit=${limit}`);
    return {
      voters: res?.voters || [],
      total: res?.total || (res?.voters || []).length
    };
  } catch (err) {
    console.warn('[fetchPostVoters]', err);
    return { voters: [], total: 0 };
  }
};

/**
 * checkPostVote
 * Quick check if user already voted on a post.
 *
 * Server-side for the same reason as getVotesInTopic — the old
 * `pb.collection('reputation_votes')` read could only ever 403. One
 * `getVotesInTopic` answers this for a whole topic, so a caller that already
 * holds those votes does not pay for a second request.
 */
export const checkPostVote = async (voterUid, postId) => {
  if (!voterUid || !postId) return false;
  try {
    const res = await sendApi('/api/aerun/me/votes');
    return (res?.items || []).some(r => r.post_id === postId);
  } catch {
    return false;
  }
};

/**
 * deleteReputation
 * Allows an admin/moderator to delete a reputation log entry.
 */
export const deleteReputation = async (logId, _performerId) => {
  if (!logId) return;
  return await sendApi(`/api/aerun/reputation/${logId}`, {
    method: 'DELETE'
  });
};
