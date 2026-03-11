import {
  collection,
  doc,
  runTransaction,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  getDocs,
  getDoc,
  limit
} from 'firebase/firestore';
import { db } from '../../firebase';

/**
 * voteOnPost
 * Allows a user to vote on a specific post.
 * Uses a transaction to ensure atomic updates and 1-vote limit.
 */
export const voteOnPost = async (voterUid, targetUid, postId, topicId, value, comment, topicTitle, postNumber) => {
  if (voterUid === targetUid) throw new Error('You cannot vote for yourself.');

  const voteId = `${voterUid}_post_${postId}`;
  const logRef = doc(db, 'reputation_logs', voteId);
  const voterRef = doc(db, 'users', voterUid);
  const userRef = doc(db, 'users', targetUid);
  const postRef = doc(db, 'posts', postId);

  await runTransaction(db, async (transaction) => {
    const logDoc = await transaction.get(logRef);
    if (logDoc.exists()) {
      throw new Error('Already voted on this post.');
    }

    const voterDoc = await transaction.get(voterRef);
    const voterNickname = voterDoc.exists() ? voterDoc.data().nickname : 'User';

    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists()) throw new Error('Target user not found.');

    const currentRep = userDoc.data().reputation || 0;

    const postDoc = await transaction.get(postRef);
    const currentPostRep = postDoc.exists() ? (postDoc.data().reputation || 0) : 0;

    // 1. Create log entry
    transaction.set(logRef, {
      voter_id: voterUid,
      voter_nickname: voterNickname,
      target_id: targetUid,
      post_id: postId,
      topic_id: topicId,
      topic_title: topicTitle || '',
      post_number: postNumber || null,
      value: value,
      comment: comment || '',
      created_at: serverTimestamp()
    });

    // 2. Update user reputation
    transaction.update(userRef, {
      reputation: currentRep + value
    });

    // 3. Update post reputation
    transaction.update(postRef, {
      reputation: currentPostRep + value
    });
  });
};

/**
 * getVotesInTopic
 * Fetches all votes cast by a specific user in a specific topic.
 */
export const getVotesInTopic = async (voterUid, topicId) => {
  const q = query(
    collection(db, 'reputation_logs'),
    where('voter_id', '==', voterUid),
    where('topic_id', '==', topicId)
  );

  const snapshot = await getDocs(q);
  const votes = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.post_id) {
      votes[data.post_id] = {
        id: doc.id,
        ...data
      };
    }
  });
  return votes;
};

/**
 * voteOnProfile
 * Allows a user to vote on another's profile with a comment.
 * Uses a deterministic ID to enforce 1-vote limit per profile.
 */
export const voteOnProfile = async (voterUid, targetUid, value, comment) => {
  if (voterUid === targetUid) throw new Error('You cannot vote for yourself.');

  const voteId = `${voterUid}_user_${targetUid}`;
  const logRef = doc(db, 'reputation_logs', voteId);
  const voterRef = doc(db, 'users', voterUid);
  const userRef = doc(db, 'users', targetUid);

  await runTransaction(db, async (transaction) => {
    const logDoc = await transaction.get(logRef);
    if (logDoc.exists()) {
      throw new Error('Already voted on this profile.');
    }

    const voterDoc = await transaction.get(voterRef);
    const voterNickname = voterDoc.exists() ? voterDoc.data().nickname : 'User';

    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists()) throw new Error('Target user not found.');

    const currentRep = userDoc.data().reputation || 0;

    transaction.set(logRef, {
      voter_id: voterUid,
      voter_nickname: voterNickname,
      target_id: targetUid,
      value: value,
      comment: comment || '',
      post_id: null,
      created_at: serverTimestamp()
    });

    transaction.update(userRef, {
      reputation: currentRep + value
    });
  });
};

/**
 * getProfileVote
 * Checks if a user has already voted for a specific profile.
 */
export const getProfileVote = async (voterUid, targetUid) => {
  const voteId = `${voterUid}_user_${targetUid}`;
  const logDoc = await getDoc(doc(db, 'reputation_logs', voteId));
  if (logDoc.exists()) {
    return { id: logDoc.id, ...logDoc.data() };
  }
  return null;
};

/**
 * subscribeToReputationLogs
 * Real-time list of reputation changes for a user.
 */
export const subscribeToReputationLogs = (uid, callback) => {
  const q = query(
    collection(db, 'reputation_logs'),
    where('target_id', '==', uid),
    orderBy('created_at', 'desc'),
    limit(50)
  );

  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    callback(logs);
  });
};

/**
 * hasVotedOnPost
 * Quick check if user already voted on a post using the deterministic ID.
 */
export const checkPostVote = async (voterUid, postId) => {
  const voteId = `${voterUid}_post_${postId}`;
  const logDoc = await getDoc(doc(db, 'reputation_logs', voteId));
  return logDoc.exists();
};
