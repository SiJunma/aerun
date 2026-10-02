import { sendApi, pb } from './pocketbase';

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
 */
export const getVotesInTopic = async (voterUid, topicId) => {
  if (!voterUid || !topicId) return {};
  try {
    const records = await pb.collection('reputation_votes').getFullList({
      filter: `voter_id = "${voterUid}" && topic_id = "${topicId}"`
    });
    const votes = {};
    records.forEach(r => {
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
 */
export const getProfileVote = async (voterUid, targetUid) => {
  if (!voterUid || !targetUid) return null;
  try {
    const record = await pb.collection('reputation_votes').getFirstListItem(
      `voter_id = "${voterUid}" && target_id = "${targetUid}" && post_id = ""`
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
 */
export const checkPostVote = async (voterUid, postId) => {
  if (!voterUid || !postId) return false;
  try {
    const record = await pb.collection('reputation_votes').getFirstListItem(
      `voter_id = "${voterUid}" && post_id = "${postId}"`
    );
    return !!record;
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
