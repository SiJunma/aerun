import { sendApi, pb } from './pocketbase';

/**
 * voteOnPost
 * Allows a user to vote on a specific post.
 */
export const voteOnPost = async (voterUid, targetUid, postId, topicId, value, comment, topicTitle, postNumber, voterNickname = 'User') => {
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
export const voteOnProfile = async (voterUid, targetUid, value, comment, voterNickname = 'User') => {
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
 * updateReputationComment
 * Allows a user to edit their reputation comment.
 */
export const updateReputationComment = async (logId, newComment, postId = null) => {
  if (postId) {
    return await sendApi(`/api/aerun/posts/${postId}/vote`, {
      method: 'POST',
      body: { comment: newComment || '' }
    });
  }
  try {
    return await pb.collection('reputation_votes').update(logId, {
      comment: newComment || ''
    });
  } catch (err) {
    console.warn('[updateReputationComment]', err);
  }
};

/**
 * fetchReputationLogs
 * Fetches reputation changes for a user securely through backend API.
 */
export const fetchReputationLogs = async (uid, page = 1, pageSize = 20, seekLogId = null) => {
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
export const deleteReputation = async (logId, performerId) => {
  if (!logId) return;
  return await sendApi(`/api/aerun/reputation/${logId}`, {
    method: 'DELETE'
  });
};
