import { db } from '../../firebase';
import { collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, getDocs, startAfter } from 'firebase/firestore';

/**
 * Logs an administrative or moderative action.
 * 
 * @param {string} actionType - E.g., 'category_created', 'user_banned', 'settings_updated'
 * @param {string} performerId - The UID of the admin/moderator who performed the action
 * @param {Object} details - Additional contextual info (e.g., targetId, targetName, old/new values)
 */
export const logAdminAction = async (actionType, performerId, details = {}) => {
  try {
    if (!performerId) return; // Silent return if no performer
    
    await addDoc(collection(db, 'audit_logs'), {
      action_type: actionType,
      performer_id: performerId,
      details,
      created_at: serverTimestamp(),
    });
  } catch (error) {
    console.error('Failed to log admin action:', error);
    // Don't throw so that the main action (which succeeded) doesn't seem like it failed
  }
};

/**
 * Subscribes to the latest audit logs.
 * 
 * @param {number} limitCount - Max logs to fetch initially
 * @param {function} callback - Callback function receiving the logs array
 * @returns {function} Unsubscribe function
 */
export const subscribeToAuditLogs = (limitCount = 50, callback) => {
  const q = query(
    collection(db, 'audit_logs'),
    orderBy('created_at', 'desc'),
    limit(limitCount)
  );

  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));
    callback(logs);
  }, (error) => {
    console.error('Error listening to audit logs:', error);
  });
};

/**
 * Fetch more logs for pagination (cursor based on last doc).
 * 
 * @param {Object} lastDoc - The last document snapshot from previous query
 * @param {number} limitCount - Max logs to fetch
 * @returns {Promise<Object>} Formatted logs array and the new lastDoc snapshot
 */
export const getMoreAuditLogs = async (lastDoc, limitCount = 50) => {
  if (!lastDoc) return { logs: [], lastDoc: null };

  const q = query(
    collection(db, 'audit_logs'),
    orderBy('created_at', 'desc'),
    startAfter(lastDoc),
    limit(limitCount)
  );

  const snapshot = await getDocs(q);
  const logs = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));

  const newLastDoc = snapshot.docs[snapshot.docs.length - 1] || null;
  return { logs, lastDoc: newLastDoc };
};
