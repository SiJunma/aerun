const { loadContext, invalidateContext, hasViewForum, getRequester, isRuleAdmin, hasRulePermission, hasRuleCategoryPermission } = require("./permissions");
const { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { sendBrevoEmail, renderDmNotificationEmail, renderTopicReplyEmail } = require("./email");

admin.initializeApp();

// Ensure only a reasonable amount of instances run at once to manage billing safely
setGlobalOptions({ maxInstances: 10, cors: true, enforceAppCheck: false, memory: "512MiB" });

async function sendRtdbNotification(recipientUid, notifData) {
  if (!recipientUid) return;
  try {
    const rtdb = admin.database();
    const notifsRef = rtdb.ref(`notifications/${recipientUid}`).push();
    await notifsRef.set({
      id: notifsRef.key,
      recipient_uid: recipientUid,
      read: false,
      created_at: Date.now(),
      ...notifData
    });
  } catch (err) {
    logger.warn('[sendRtdbNotification err]', err);
  }
}

async function sendRtdbAdminNotification(notifData) {
  try {
    const rtdb = admin.database();
    const adminRef = rtdb.ref('admin_notifications').push();
    await adminRef.set({
      id: adminRef.key,
      read: false,
      created_at: Date.now(),
      ...notifData
    });
  } catch (err) {
    logger.warn('[sendRtdbAdminNotification err]', err);
  }
}

// ── RTDB Caching Helpers ───────────────────────────────────────────────────────

async function updateRtdbMainPageCategory(catId, updates) {
  if (!catId) return;
  try {
    const rtdb = admin.database();
    await rtdb.ref(`main_page_cache/categories/${catId}`).update(updates);
  } catch (err) {
    logger.warn(`[updateRtdbMainPageCategory] ${catId} err:`, err);
  }
}

async function removeRtdbMainPageCategory(catId) {
  if (!catId) return;
  try {
    const rtdb = admin.database();
    await rtdb.ref(`main_page_cache/categories/${catId}`).remove();
  } catch (err) {
    logger.warn(`[removeRtdbMainPageCategory] ${catId} err:`, err);
  }
}

function serialiseCategoryForRtdb(catId, category) {
  const serialiseDate = (value) => value?.toDate ? value.toDate().toISOString() : (value || null);
  return {
    ...category,
    id: catId,
    created_at: serialiseDate(category.created_at),
    updated_at: serialiseDate(category.updated_at),
    last_post_at: serialiseDate(category.last_post_at)
  };
}

async function invalidateAllSessionPerms(reason) {
  try {
    const rtdb = admin.database();
    const permsSnap = await rtdb.ref('session_perms').once('value');
    const allPerms = permsSnap.val();
    if (!allPerms) return;
    const updates = {};
    Object.keys(allPerms).forEach(key => {
      updates[`${key}/expires_at`] = 0;
    });
    await rtdb.ref('session_perms').update(updates);
    logger.info(`[permissions] Invalidated ${Object.keys(allPerms).length} session entries: ${reason}`);
  } catch (err) {
    logger.warn(`[permissions] session_perms invalidation failed: ${reason}`, err);
  }
}

async function updateRtdbLatestTopic(topicId, updates) {
  if (!topicId) return;
  try {
    const rtdb = admin.database();
    await rtdb.ref(`main_page_cache/latest_topics/${topicId}`).update(updates);
  } catch (err) {
    logger.warn(`[updateRtdbLatestTopic] ${topicId} err:`, err);
  }
}

async function removeRtdbLatestTopic(topicId) {
  if (!topicId) return;
  try {
    const rtdb = admin.database();
    await rtdb.ref(`main_page_cache/latest_topics/${topicId}`).remove();
  } catch (err) {
    logger.warn(`[removeRtdbLatestTopic] ${topicId} err:`, err);
  }
}

/**
 * Resolves once the RTDB main_page_cache satisfies the predicate.
 *
 * Mutation callables perform the write the client used to do and then WAIT for
 * the async Firestore triggers to denormalise the projection — so the callable
 * returns genuinely converged data instead of making the client poll again.
 * Resolves with the converged value, or null when the timeout elapses.
 */
function waitForRtdbConvergence(path, predicate, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const ref = admin.database().ref(path);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ref.off("value", onChange);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onChange = (snap) => {
      const val = snap.val();
      if (predicate(val)) finish(val);
    };
    ref.on("value", onChange);
  });
}

/**
 * Firestore variant of waitForRtdbConvergence: polls the document the
 * projection actually reads. The RTDB mirrors can satisfy their predicates
 * through secondary writers — e.g. syncTopicMetadata's topicRef.update fires
 * onTopicUpdated, which mirrors the topic into latest_topics BEFORE
 * syncCategoryMetadata lands — so a satisfied RTDB predicate does not strictly
 * imply the Firestore denormalisation is committed. Polling the source
 * document is immune to trigger ordering.
 */
function waitForFirestoreConvergence(docRef, predicate, timeoutMs = 8000, intervalMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      resolve(val);
    };
    const timer = setInterval(async () => {
      try {
        const snap = await docRef.get();
        if (predicate(snap.exists ? snap.data() : null)) finish(true);
      } catch (err) {
        logger.warn("[waitForFirestoreConvergence] poll error:", err);
      }
    }, intervalMs);
    const timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

async function mirrorPostToRtdbCache(topicId, postId, postData, postsPerPage = 20) {
  if (!topicId || !postId) return;
  try {
    const rtdb = admin.database();
    const topicRef = rtdb.ref(`topic_posts_cache/${topicId}`);
    const cacheSize = (postsPerPage || 20) * 3;

    // Гарантируем корректный числовой timestamp для сортировки в RTDB
    let createdAtMs = Date.now();
    if (postData.created_at?.toMillis) {
      createdAtMs = postData.created_at.toMillis();
    } else if (postData.created_at && !isNaN(new Date(postData.created_at).getTime())) {
      createdAtMs = new Date(postData.created_at).getTime();
    }

    const editedAtMs = postData.edited_at?.toMillis
      ? postData.edited_at.toMillis()
      : (postData.edited_at ? new Date(postData.edited_at).getTime() : null);

    const postPayload = {
      id: postId,
      topic_id: topicId,
      author_id: postData.author_id || null,
      author_name: postData.author_name || 'User',
      author_avatar: postData.author_avatar || '',
      author_status_line: postData.author_status_line || '',
      author_signature: postData.author_signature || '',
      author_role_id: postData.author_role_id || 'player',
      author_posts_count: postData.author_posts_count || 0,
      author_reputation: postData.author_reputation || 0,
      is_character: !!postData.is_character,
      author_character_id: postData.author_character_id || null,
      content: postData.content || '',
      rolls: postData.rolls || null,
      reputation: postData.reputation || 0,
      created_at: createdAtMs,
      edited_at: editedAtMs
    };

    // 1. Сохраняем пост в RTDB
    await topicRef.child(`posts/${postId}`).set(postPayload);

    // 2. Обновляем метаданные темы для слушателей
    await topicRef.child('meta').update({
      last_post_at: createdAtMs,
      last_post_id: postId,
      cache_size: cacheSize,
      category_id: postData.category_id || null
    });

    // 3. Подрезаем старые посты, если их больше размера кэша (3 страницы)
    const postsSnap = await topicRef.child('posts').orderByChild('created_at').once('value');
    if (postsSnap.exists()) {
      const count = postsSnap.numChildren();
      if (count > cacheSize) {
        let toRemove = count - cacheSize;
        postsSnap.forEach(child => {
          if (toRemove > 0) {
            child.ref.remove().catch(() => { });
            toRemove--;
          }
        });
      }
    }
  } catch (err) {
    logger.warn(`[mirrorPostToRtdbCache] topic=${topicId} err:`, err);
  }
}

async function removePostFromRtdbCache(topicId, postId) {
  if (!topicId || !postId) return;
  try {
    const rtdb = admin.database();
    await rtdb.ref(`topic_posts_cache/${topicId}/posts/${postId}`).remove();
  } catch (err) {
    logger.warn(`[removePostFromRtdbCache] topic=${topicId} post=${postId} err:`, err);
  }
}

async function updatePostInRtdbCache(topicId, postId, updates) {
  if (!topicId || !postId) return;
  try {
    const rtdb = admin.database();
    const postRef = rtdb.ref(`topic_posts_cache/${topicId}/posts/${postId}`);
    const snap = await postRef.once('value');
    if (snap.exists()) {
      await postRef.update(updates);
    }
  } catch (err) {
    logger.warn(`[updatePostInRtdbCache] topic=${topicId} post=${postId} err:`, err);
  }
}

/**
 * Atomic Reputation Handler (Create)
 * Fired when a reputation_log is created.
 */
exports.onReputationLogCreated = onDocumentCreated("reputation_logs/{logId}", async (event) => {
  const snap = event.data;
  if (!snap) return;

  const log = snap.data();
  const { target_id, post_id, value } = log;

  if (!target_id || typeof value !== 'number') {
    logger.error(`onReputationLogCreated: Malformed log document ${snap.id}`, log);
    return;
  }

  try {
    const db = admin.firestore();

    // Firestore triggers are at-least-once: a redelivery would increment twice.
    // Claim the log first; the update does not re-fire onDocumentCreated.
    const logRef = db.collection("reputation_logs").doc(snap.id);
    const claimed = await db.runTransaction(async (tx) => {
      const cur = await tx.get(logRef);
      if (!cur.exists || cur.data().applied === true) return false;
      tx.update(logRef, { applied: true });
      return true;
    });
    if (!claimed) {
      logger.info(`onReputationLogCreated: log ${snap.id} already applied, skipping`);
      return;
    }

    const batch = db.batch();

    // 1. Update target user reputation
    const userRef = db.collection("users").doc(target_id);
    await queueIncrement(batch, userRef, "reputation", value);

    // 2. Update associated post reputation (if post_id exists)
    if (post_id) {
      const postRef = db.collection("posts").doc(post_id);
      await queueIncrement(batch, postRef, "reputation", value);
    }

    // 3. Resolve topic_title if missing from log
    let topicTitle = log.topic_title || null;
    if (!topicTitle && log.topic_id) {
      try {
        const tSnap = await db.collection("topics").doc(log.topic_id).get();
        if (tSnap.exists) {
          topicTitle = tSnap.data().title || null;
        }
      } catch (tErr) {
        logger.warn(`[onReputationLogCreated] Could not resolve topic title for ${log.topic_id}:`, tErr);
      }
    }

    // 4. Create notification (Firestore backup)
    const notifRef = db.collection("notifications").doc();
    const notifPayload = {
      voter_nickname: log.voter_nickname || "User",
      value: value,
      topic_id: log.topic_id || null,
      topic_title: topicTitle,
      post_id: log.post_id || null,
      comment: log.comment || ""
    };
    batch.set(notifRef, {
      recipient_uid: target_id,
      type: "reputation_change",
      read: false,
      archived: false,
      payload: notifPayload,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    // 5. Send real-time RTDB notification (instant & 0 Firestore read cost for client)
    await sendRtdbNotification(target_id, {
      type: "reputation_change",
      payload: notifPayload
    });

    // 6. Sync voter to RTDB post_voters cache for instant modal loading
    if (post_id) {
      try {
        let voterAvatar = null;
        let voterNickname = log.voter_nickname || "User";
        if (log.voter_id) {
          const voterSnap = await db.collection("users").doc(log.voter_id).get();
          if (voterSnap.exists) {
            const vData = voterSnap.data();
            voterAvatar = vData.avatar_url || null;
            if (vData.nickname) voterNickname = vData.nickname;
          }
        }
        await admin.database().ref(`post_voters/${post_id}/${snap.id}`).set({
          log_id: snap.id,
          voter_id: log.voter_id || null,
          voter_nickname: voterNickname,
          avatar_url: voterAvatar,
          value: value,
          comment: log.comment || "",
          created_at: Date.now()
        });
      } catch (rtdbErr) {
        logger.warn(`[onReputationLogCreated] RTDB post_voters sync failed:`, rtdbErr);
      }
    }

    logger.info(`Reputation applied for log ${snap.id}: target=${target_id}, value=${value}`);
  } catch (error) {
    logger.error(`Error processing reputation log ${snap.id}:`, error);
  }
});

/**
 * Atomic Reputation Handler (Delete)
 * Fired when a reputation_log is deleted. Reverts the reputation change.
 * Sole owner of the revert — onPostDeleted must not duplicate it.
 */
exports.onReputationLogDeleted = onDocumentDeleted("reputation_logs/{logId}", async (event) => {
  const snap = event.data;
  if (!snap) return;

  const log = snap.data();
  const { target_id, post_id, value } = log;

  if (!target_id || typeof value !== 'number' || value === 0) return;

  try {
    const db = admin.firestore();

    // Firestore triggers are at-least-once. onReputationLogCreated claims the
    // log through an `applied` flag for exactly this reason, but this path had no
    // equivalent guard, so a redelivery reverted the reputation twice. Deleting a
    // whole topic now removes many logs at once, which multiplies that risk, so
    // the revert is claimed with a create() that fails when the marker already
    // exists — an in-document flag cannot work here, the document is gone.
    const claimRef = db.collection("reputation_reverts").doc(snap.id);
    try {
      await claimRef.create({
        log_id: snap.id,
        target_id,
        post_id: post_id || null,
        value,
        reverted_at: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {
      logger.info(`onReputationLogDeleted: log ${snap.id} already reverted, skipping`);
      return;
    }

    const batch = db.batch();

    // batch.update() on a missing document aborts the WHOLE commit, and both
    // the post and the user may already be gone by the time this fires.
    const userQueued = await queueIncrement(batch, db.collection("users").doc(target_id), "reputation", -value);
    if (post_id) {
      await queueIncrement(batch, db.collection("posts").doc(post_id), "reputation", -value);
      try {
        await admin.database().ref(`post_voters/${post_id}/${snap.id}`).remove();
      } catch (rtdbErr) {
        logger.warn(`[onReputationLogDeleted] RTDB post_voters removal failed:`, rtdbErr);
      }
    }

    await batch.commit();
    logger.info(`Reputation reverted for deleted log ${snap.id}: target=${target_id}, value=${-value}, user=${userQueued}`);
  } catch (error) {
    // Background triggers must never throw HttpsError — it means nothing outside
    // a callable and just produces an unhandled rejection.
    logger.error(`Error reverting reputation log ${snap.id}:`, error);
  }
});

/**
 * Reputation Handler (Update)
 * Fired when a reputation comment is edited.
 */
exports.onReputationLogUpdated = onDocumentUpdated("reputation_logs/{logId}", async (event) => {
  const afterSnap = event.data.after;
  if (!afterSnap) return;
  const log = afterSnap.data();
  const { post_id, comment } = log;

  if (post_id) {
    try {
      await admin.database().ref(`post_voters/${post_id}/${afterSnap.id}/comment`).set(comment || "");
    } catch (err) {
      logger.warn(`[onReputationLogUpdated] RTDB comment update failed:`, err);
    }
  }
});

/**
 * locatePost (Callable)
 * Resolves the page number of a given post inside a topic.
 */
exports.locatePost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { postId, itemsPerPage = 20 } = request.data;
    if (!postId) return { found: false, reason: 'missing_post_id' };

    const db = admin.firestore();
    try {
      const postSnap = await db.collection('posts').doc(postId).get();
      if (!postSnap.exists) return { found: false, reason: 'not_found' };

      const { topic_id: topicId, created_at: createdAt } = postSnap.data();
      if (!topicId) return { found: false, reason: 'missing_topic_id' };

      if (!createdAt) {
        return { found: true, topicId, postId, page: 1, anchor: `#post-${postId}` };
      }

      // 1. Считаем сколько постов идет ДО целевого поста (0-based count)
      const priorPostsQuery = db.collection('posts')
        .where('topic_id', '==', topicId)
        .where('created_at', '<', createdAt);

      const countSnap = await priorPostsQuery.count().get();
      const countBefore = countSnap.data().count;

      // 2. ИСПРАВЛЕНИЕ: Номер сообщения по порядку = countBefore + 1
      // Считаем 1-based страницу (Math.ceil от 1-based номера)
      const page = Math.max(1, Math.ceil((countBefore + 1) / itemsPerPage));

      return { found: true, topicId, postId, page, anchor: `#post-${postId}` };
    } catch (err) {
      console.error('[locatePost]', err);
      return { found: false, reason: 'error' };
    }
  }
);

/**
 * locateUnreadPost (Callable)
 * Resolves the page number of the first unread post in a topic based on lastVisitMs.
 */
exports.locateUnreadPost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { topicId, lastVisitMs, itemsPerPage = 20 } = request.data;
    if (!topicId || !lastVisitMs) return { found: false, reason: 'missing_args' };

    const db = admin.firestore();
    try {
      const priorPostsQuery = db.collection('posts')
        .where('topic_id', '==', topicId)
        .where('created_at', '<=', admin.firestore.Timestamp.fromMillis(lastVisitMs));

      const countSnap = await priorPostsQuery.count().get();
      const countBefore = countSnap.data().count;

      // ИСПРАВЛЕНИЕ: Переводим в 1-based страницу
      const unreadPage = Math.max(1, Math.ceil((countBefore + 1) / itemsPerPage));
      return { found: true, page: unreadPage };
    } catch (err) {
      console.error('[locateUnreadPost]', err);
      return { found: false, reason: 'error' };
    }
  }
);

/**
 * getSecuredCategories (Callable)
 * Retrieves categories the user has permission to view.
 */
exports.getSecuredCategories = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;

    let requesterRole = 'guest';
    let isRestricted = false;

    if (uid) {
      const userDoc = await db.collection("users").doc(uid).get();
      if (userDoc.exists) {
        const uData = userDoc.data();
        requesterRole = uData.role_id || 'player';
        if (requesterRole === 'pending') isRestricted = true;
      }
    }

    const settingsSnap = await db.collection("settings").doc("global").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const isWhitelistOff = !settings.whitelistMode;

    let effectiveRole = requesterRole;
    if (isRestricted && isWhitelistOff) effectiveRole = 'spectator';

    const rolesSnap = await db.collection("roles").get();
    const rolesMap = {};
    rolesSnap.forEach(d => rolesMap[d.id] = d.data());

    const categoriesSnap = await db.collection("categories").orderBy('order', 'asc').get();
    const categories = [];

    categoriesSnap.forEach(doc => {
      const catData = doc.data();
      catData.id = doc.id;

      if (catData.created_at) catData.created_at = catData.created_at.toDate().toISOString();
      if (catData.updated_at) catData.updated_at = catData.updated_at.toDate().toISOString();
      if (catData.last_post_at) catData.last_post_at = catData.last_post_at.toDate().toISOString();

      if (['root', 'admin'].includes(requesterRole)) {
        categories.push(catData);
        return;
      }

      const catPerms = catData.permissions || {};
      const allowedRoles = catPerms['view_forum'];

      let hasViewPerm = false;
      if (!allowedRoles) {
        const roleData = rolesMap[effectiveRole];
        hasViewPerm = (roleData?.permissions || []).includes('view_forum');
      } else {
        if (allowedRoles.includes(effectiveRole)) {
          hasViewPerm = true;
        } else {
          const roleData = rolesMap[effectiveRole];
          if (roleData?.base_role_id && allowedRoles.includes(roleData.base_role_id)) {
            hasViewPerm = true;
          }
        }
      }

      if (hasViewPerm) {
        categories.push(catData);
      }
    });

    return { categories };
  }
);

/** Firestore Timestamps are not JSON-serialisable over the callable protocol. */
function serializeTopic(doc) {
  const data = { id: doc.id, ...doc.data() };
  ['created_at', 'updated_at', 'last_post_at'].forEach(k => {
    if (data[k]?.toDate) data[k] = data[k].toDate().toISOString();
  });
  return data;
}

// Server-side in-memory caches to save 90%+ Firestore reads across callable invocations
const serverUserCache = new Map(); // uid -> { data, ts }
const serverCharCache = new Map(); // key -> { data, ts }
const SERVER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Hydrates author & character profile metadata dynamically for a list of posts or topics.
 * Fetches current nicknames, avatars, statuses, signatures, and roles using server-side in-memory caching.
 */
async function hydrateAuthorProfiles(db, items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  try {
    const now = Date.now();
    const missingUids = new Set();
    const missingCharRequests = [];
    const userProfiles = {};
    const charProfiles = {};

    items.forEach(item => {
      // 1. Author UIDs
      [item.author_id, item.last_post_author_id].forEach(uid => {
        if (!uid) return;
        const cached = serverUserCache.get(uid);
        if (cached && (now - cached.ts < SERVER_CACHE_TTL)) {
          userProfiles[uid] = cached.data;
        } else {
          missingUids.add(uid);
        }
      });

      // 2. Character requests
      if (item.is_character && item.author_id && item.author_character_id) {
        const key = `${item.author_id}_${item.author_character_id}`;
        const cached = serverCharCache.get(key);
        if (cached && (now - cached.ts < SERVER_CACHE_TTL)) {
          charProfiles[key] = cached.data;
        } else {
          missingCharRequests.push({ uid: item.author_id, charId: item.author_character_id, key });
        }
      }
      if (item.last_post_is_character && item.last_post_author_id && item.last_post_author_character_id) {
        const key = `${item.last_post_author_id}_${item.last_post_author_character_id}`;
        const cached = serverCharCache.get(key);
        if (cached && (now - cached.ts < SERVER_CACHE_TTL)) {
          charProfiles[key] = cached.data;
        } else {
          missingCharRequests.push({ uid: item.last_post_author_id, charId: item.last_post_author_character_id, key });
        }
      }
    });

    // Batch fetch missing users
    const missingUidArr = [...missingUids];
    if (missingUidArr.length > 0) {
      for (let i = 0; i < missingUidArr.length; i += 30) {
        const chunk = missingUidArr.slice(i, i + 30);
        const snap = await db.collection('users')
          .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
          .get();
        snap.forEach(d => {
          const dData = d.data();
          userProfiles[d.id] = dData;
          serverUserCache.set(d.id, { data: dData, ts: now });
        });
      }
    }

    // Batch fetch missing characters
    if (missingCharRequests.length > 0) {
      await Promise.all(missingCharRequests.map(async ({ uid, charId, key }) => {
        if (charProfiles[key]) return;
        try {
          const charSnap = await db.collection('users').doc(uid).collection('characters').doc(charId).get();
          if (charSnap.exists) {
            const cData = charSnap.data();
            charProfiles[key] = cData;
            serverCharCache.set(key, { data: cData, ts: now });
          }
        } catch (err) {
          logger.warn(`[hydrateAuthorProfiles] Error fetching character ${key}:`, err);
        }
      }));
    }

    items.forEach(item => {
      if (item.author_id && userProfiles[item.author_id]) {
        const u = userProfiles[item.author_id];
        item.author_role_id = u.role_id || item.author_role_id;
        item.author_status_line = u.status_line !== undefined ? u.status_line : (item.author_status_line || '');
        item.author_signature = (u.settings?.signature !== undefined ? u.settings.signature : (u.signature !== undefined ? u.signature : (item.author_signature || '')));
        item.author_posts_count = u.post_count !== undefined ? u.post_count : (item.author_posts_count || 0);
        item.author_reputation = u.reputation !== undefined ? u.reputation : (item.author_reputation || 0);

        if (!item.is_character) {
          if (u.nickname) item.author_name = u.nickname;
          if (u.avatar_url !== undefined) item.author_avatar = u.avatar_url || '';
        }
      }

      if (item.is_character && item.author_id && item.author_character_id) {
        const key = `${item.author_id}_${item.author_character_id}`;
        if (charProfiles[key]) {
          const c = charProfiles[key];
          if (c.name) item.author_name = c.name;
          if (c.avatar_url !== undefined) item.author_avatar = c.avatar_url || '';
          if (c.status_line !== undefined) item.author_status_line = c.status_line;
          if (c.signature !== undefined) item.author_signature = c.signature;
        }
      }

      if (item.last_post_author_id && userProfiles[item.last_post_author_id]) {
        const u = userProfiles[item.last_post_author_id];
        if (!item.last_post_is_character) {
          if (u.nickname) item.last_post_author = u.nickname;
          if (u.avatar_url !== undefined) item.last_post_author_avatar = u.avatar_url || '';
        }
      }

      if (item.last_post_is_character && item.last_post_author_id && item.last_post_author_character_id) {
        const key = `${item.last_post_author_id}_${item.last_post_author_character_id}`;
        if (charProfiles[key]) {
          const c = charProfiles[key];
          if (c.name) item.last_post_author = c.name;
          if (c.avatar_url !== undefined) item.last_post_author_avatar = c.avatar_url || '';
        }
      }
    });
  } catch (err) {
    logger.error('[hydrateAuthorProfiles error]', err);
  }

  return items;
}

/**
 * getSecuredTopics (Callable)
 * Retrieves topics for a category the user has permission to view.
 */
exports.getSecuredTopics = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { categoryId, page = 1, pageSize = 20 } = request.data;
    if (!categoryId) throw new HttpsError('invalid-argument', 'Missing categoryId');

    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;

    let requesterRole = 'guest';
    let isRestricted = false;

    if (uid) {
      const userDoc = await db.collection("users").doc(uid).get();
      if (userDoc.exists) {
        const uData = userDoc.data();
        requesterRole = uData.role_id || 'player';
        if (requesterRole === 'pending') isRestricted = true;
      }
    }

    const catDoc = await db.collection("categories").doc(categoryId).get();
    if (!catDoc.exists) throw new HttpsError('not-found', 'Category not found');
    const catData = catDoc.data();

    // Permissions check
    let hasViewPerm = false;
    if (['root', 'admin'].includes(requesterRole)) {
      hasViewPerm = true;
    } else {
      const settingsSnap = await db.collection("settings").doc("global").get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const isWhitelistOff = !settings.whitelistMode;
      let effectiveRole = requesterRole;
      if (isRestricted && isWhitelistOff) effectiveRole = 'spectator';

      const catPerms = catData.permissions || {};
      const allowedRoles = catPerms['view_forum'];

      if (!allowedRoles) {
        const roleDoc = await db.collection("roles").doc(effectiveRole).get();
        if (roleDoc.exists && (roleDoc.data().permissions || []).includes('view_forum')) {
          hasViewPerm = true;
        }
      } else {
        if (allowedRoles.includes(effectiveRole)) {
          hasViewPerm = true;
        } else {
          const roleDoc = await db.collection("roles").doc(effectiveRole).get();
          if (roleDoc.exists && roleDoc.data().base_role_id && allowedRoles.includes(roleDoc.data().base_role_id)) {
            hasViewPerm = true;
          }
        }
      }
    }

    if (!hasViewPerm) {
      throw new HttpsError('permission-denied', 'You do not have permission to view topics in this category.');
    }

    const startIndex = (page - 1) * pageSize;

    // 1. Pinned topics (page 1 only, small in number)
    const pinnedTopics = [];
    if (page === 1) {
      const pinnedSnap = await db.collection("topics")
        .where("category_id", "==", categoryId)
        .where("is_pinned", "==", true)
        .orderBy("last_post_at", "desc")
        .get();
      pinnedSnap.forEach(doc => pinnedTopics.push(serializeTopic(doc)));
    }

    // 2. Regular topics — pinned excluded IN THE QUERY. Filtering after
    //    offset()+limit() silently dropped a topic for every pinned one that
    //    happened to fall inside the window.
    //    Requires is_pinned on every document: backfill legacy topics once with
    //    { is_pinned: false } — Firestore skips documents where the field is absent.
    const [countSnap, topicsSnap] = await Promise.all([
      db.collection("topics")
        .where("category_id", "==", categoryId)
        .where("is_pinned", "==", false)
        .count().get(),
      db.collection("topics")
        .where("category_id", "==", categoryId)
        .where("is_pinned", "==", false)
        .orderBy("last_post_at", "desc")
        .offset(startIndex)
        .limit(pageSize)
        .get()
    ]);

    const topics = [];
    topicsSnap.forEach(doc => topics.push(serializeTopic(doc)));
    const totalCount = countSnap.data().count;

    await hydrateAuthorProfiles(db, pinnedTopics);
    await hydrateAuthorProfiles(db, topics);

    return { pinned: pinnedTopics, topics, totalCount, hasMore: totalCount > startIndex + pageSize };
  }
);

/**
 * getSecuredGlobalTopics (Callable)
 * Retrieves global topics across all allowed categories, sorted by a field.
 * Used for "New Replies" and "Active Topics" pages.
 */
exports.getSecuredGlobalTopics = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { orderByField = 'last_post_at', limitCount = 50 } = request.data;
    const db = admin.firestore();
    const requester = await getRequester(db, request.auth?.uid);
    const ctx = await loadContext(db);

    const isAllowed = (catId) => hasViewForum(requester.role, catId, ctx);

    let allTopics = [];
    let lastDoc = null;
    const BATCH_SIZE = Math.max(limitCount, 100); // fetch in batches

    while (allTopics.length < limitCount) {
      let q = db.collection('topics').orderBy(orderByField, 'desc').limit(BATCH_SIZE);
      if (lastDoc) {
        q = q.startAfter(lastDoc);
      }

      const snap = await q.get();
      // No more documents — stop fetching
      if (snap.empty) break;

      snap.forEach(doc => {
        const data = doc.data();
        if (isAllowed(data.category_id)) {
          allTopics.push(serializeTopic(doc));
        }
      });

      // If this batch returned fewer docs than requested, we've hit the end of the collection
      if (snap.size < BATCH_SIZE) break;

      lastDoc = snap.docs[snap.docs.length - 1];
    }

    const resultTopics = allTopics.slice(0, limitCount);
    await hydrateAuthorProfiles(db, resultTopics);

    return { topics: resultTopics };
  }
);

/**
 * buildMainPageProjection
 * Builds the secured main-page projection (categories / latestTopics / stats)
 * for a given uid. Reads primarily from RTDB main_page_cache, filters via
 * session_perms, and falls back to Firestore on first run. Shared by
 * getSecuredMainPageData and every mutation callable so a write returns the
 * exact payload a fresh getSecuredMainPageData call would produce — the client
 * then has no reason to poll.
 */
async function buildMainPageProjection(uid) {
  const db = admin.firestore();
  const rtdb = admin.database();
  const requester = await getRequester(db, uid);

    // 1. Check RTDB main_page_cache
    let rtdbCategories = null;
    let rtdbStats = null;
    let rtdbLatestTopics = null;

    try {
      const [catSnap, statsSnap, latestTopicsSnap] = await Promise.all([
        rtdb.ref('main_page_cache/categories').once('value'),
        rtdb.ref('main_page_cache/stats').once('value'),
        rtdb.ref('main_page_cache/latest_topics').once('value')
      ]);
      rtdbCategories = catSnap.val();
      rtdbStats = statsSnap.val();
      rtdbLatestTopics = latestTopicsSnap.val();
    } catch (err) {
      logger.warn('[getSecuredMainPageData RTDB read err]', err);
    }

    // Fallback if RTDB categories cache is empty: populate from Firestore!
    if (!rtdbCategories || Object.keys(rtdbCategories).length === 0) {
      const categoriesSnap = await db.collection("categories").orderBy('order', 'asc').get();
      rtdbCategories = {};
      const catBatch = {};

      categoriesSnap.forEach(doc => {
        const catData = doc.data();
        catData.id = doc.id;
        if (catData.created_at?.toDate) catData.created_at = catData.created_at.toDate().toISOString();
        if (catData.updated_at?.toDate) catData.updated_at = catData.updated_at.toDate().toISOString();
        if (catData.last_post_at?.toDate) catData.last_post_at = catData.last_post_at.toDate().toISOString();
        rtdbCategories[doc.id] = catData;
        catBatch[doc.id] = catData;
      });

      rtdb.ref('main_page_cache/categories').set(catBatch).catch(() => { });
    }

    // Fallback if RTDB stats cache is empty: populate from Firestore!
    if (!rtdbStats) {
      try {
        const globalStatsSnap = await db.collection("forum_stats").doc("global").get();
        if (globalStatsSnap.exists) {
          const gs = globalStatsSnap.data();
          const catsList = Object.values(rtdbCategories);
          rtdbStats = {
            total_topics: gs.total_topics ?? catsList.reduce((sum, c) => sum + (c.topics_count || 0), 0),
            total_posts: gs.total_posts ?? catsList.reduce((sum, c) => sum + (c.posts_count || 0), 0),
            total_users: gs.total_users ?? 0,
            newest_user_id: gs.newest_user?.id || null,
            newest_user_nickname: gs.newest_user?.nickname || null,
            newest_user_role_id: gs.newest_user?.role_id || null,
            updated_at: Date.now()
          };
        } else {
          const catsList = Object.values(rtdbCategories);
          const usersCountSnap = await db.collection('users').count().get();
          rtdbStats = {
            total_topics: catsList.reduce((sum, c) => sum + (c.topics_count || 0), 0),
            total_posts: catsList.reduce((sum, c) => sum + (c.posts_count || 0), 0),
            total_users: usersCountSnap.data().count,
            newest_user_id: null,
            newest_user_nickname: null,
            newest_user_role_id: null,
            updated_at: Date.now()
          };
        }
        rtdb.ref('main_page_cache/stats').set(rtdbStats).catch(() => { });
      } catch (err) {
        logger.warn('[getSecuredMainPageData stats fallback err]', err);
      }
    }

    // Fallback if RTDB latest_topics cache is empty: populate from Firestore!
    if (!rtdbLatestTopics || Object.keys(rtdbLatestTopics).length === 0) {
      try {
        const topicsSnap = await db.collection("topics").orderBy("last_post_at", "desc").limit(50).get();
        rtdbLatestTopics = {};
        const topicBatch = {};

        topicsSnap.forEach(doc => {
          const t = doc.data();
          const lpMs = t.last_post_at?.toMillis ? t.last_post_at.toMillis() : (typeof t.last_post_at === 'number' ? t.last_post_at : (t.last_post_at ? new Date(t.last_post_at).getTime() : Date.now()));
          const crMs = t.created_at?.toMillis ? t.created_at.toMillis() : (typeof t.created_at === 'number' ? t.created_at : (t.created_at ? new Date(t.created_at).getTime() : Date.now()));
          const topicObj = {
            id: doc.id,
            category_id: t.category_id || '',
            title: t.title || '',
            author_id: t.author_id || null,
            author_name: t.author_name || 'User',
            author_avatar: t.author_avatar || '',
            author_role_id: t.author_role_id || 'player',
            posts_count: t.posts_count || 1,
            views: t.views || 0,
            reputation: t.reputation || 0,
            is_pinned: !!t.is_pinned,
            is_locked: !!t.is_locked,
            created_at: crMs,
            last_post_id: t.last_post_id || null,
            last_post_at: lpMs,
            last_post_author: t.last_post_author || t.author_name || 'User',
            last_post_author_id: t.last_post_author_id || t.author_id || null,
            last_post_author_avatar: t.last_post_author_avatar || t.author_avatar || '',
            last_post_author_role_id: t.last_post_author_role_id || 'player',
            last_post_is_character: !!t.last_post_is_character,
            last_post_author_character_id: t.last_post_author_character_id || null
          };
          rtdbLatestTopics[doc.id] = topicObj;
          topicBatch[doc.id] = topicObj;
        });

        if (Object.keys(topicBatch).length > 0) {
          rtdb.ref('main_page_cache/latest_topics').set(topicBatch).catch(() => { });
        }
      } catch (err) {
        logger.warn('[getSecuredMainPageData latest_topics fallback err]', err);
      }
    }

    // 2. Categories and access checks must come from Firestore, not from the
    // RTDB cache. The cache is only a private performance layer for mutable
    // counters and latest-topic metadata.
    const permissionContext = await loadContext(db);
    const categories = Object.entries(permissionContext.categories)
      .filter(([categoryId]) => hasViewForum(requester.role, categoryId, permissionContext))
      .map(([categoryId, category]) => serialiseCategoryForRtdb(categoryId, category))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const allowedCatIds = new Set(categories.map(category => category.id));

    const latestTopics = Object.values(rtdbLatestTopics || {})
      .filter(t => allowedCatIds.has(t.category_id))
      .sort((a, b) => {
        const aMs = typeof a.last_post_at === 'number' ? a.last_post_at : (a.last_post_at ? new Date(a.last_post_at).getTime() : 0);
        const bMs = typeof b.last_post_at === 'number' ? b.last_post_at : (b.last_post_at ? new Date(b.last_post_at).getTime() : 0);
        return bMs - aMs;
      })
      .slice(0, 50);

    const stats = {
      totalTopics: rtdbStats?.total_topics ?? 0,
      totalPosts: rtdbStats?.total_posts ?? 0,
      totalUsers: rtdbStats?.total_users ?? 0,
      newestUser: rtdbStats?.newest_user_nickname ? {
        id: rtdbStats.newest_user_id,
        nickname: rtdbStats.newest_user_nickname,
        role_id: rtdbStats.newest_user_role_id
      } : null
    };

    return { categories, latestTopics, stats, dailyActiveUsers: [] };
}

/**
 * getSecuredMainPageData (Callable)
 * Combines categories and forum statistics into a single unified payload.
 */
exports.getSecuredMainPageData = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const uid = request.auth ? request.auth.uid : null;
    return buildMainPageProjection(uid);
  }
);

// ── Honest mutation callables ─────────────────────────────────────────────────
// Every write the client used to perform directly now goes through these
// callables. They validate server-side (mirroring firestore.rules), perform the
// same write, WAIT for the async denormalisation triggers to converge the RTDB
// main_page_cache, and return the converged projection. The client applies it
// directly — no blind background polling any more. On a convergence timeout the
// callable answers with converged:false and the client keeps its optimistic
// state, scheduling a single fallback refresh.

/** Shorthand for a permission-denied HttpsError. */
function deny(msg = "permission-denied") {
  return new HttpsError("permission-denied", msg);
}

/**
 * Server-owned administration of the RTDB alert stream. Clients must never
 * receive write access to this shared path because that would let every signed
 * in user forge or erase moderator notifications.
 */
exports.manageAdminNotifications = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const db = admin.firestore();
    const requester = await getRequester(db, uid);
    if (!isRuleAdmin(requester.role)) throw deny("Only administrators can manage admin notifications.");

    const { action, notificationIds } = request.data || {};
    if (!["mark_read", "delete"].includes(action)) {
      throw new HttpsError("invalid-argument", "Unsupported notification action.");
    }
    if (!Array.isArray(notificationIds) || notificationIds.length === 0 || notificationIds.length > 100) {
      throw new HttpsError("invalid-argument", "Provide from 1 to 100 notification ids.");
    }

    const updates = {};
    for (const notificationId of notificationIds) {
      if (typeof notificationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(notificationId)) {
        throw new HttpsError("invalid-argument", "Invalid notification id.");
      }
      updates[action === "mark_read"
        ? `admin_notifications/${notificationId}/read`
        : `admin_notifications/${notificationId}`] = action === "mark_read" ? true : null;
    }

    await admin.database().ref().update(updates);
    return { success: true, affected: notificationIds.length };
  }
);

/**
 * Transitional, root-only data hygiene command. Firebase Auth remains the
 * canonical private source for email addresses; public user profile documents
 * must not contain a copy because Firestore cannot hide an individual field.
 */
exports.stripProfileEmails = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const db = admin.firestore();
    const requester = await getRequester(db, uid);
    if (requester.role !== "root") throw deny("Only the root administrator can run this migration.");

    const { afterUid = null, limit = 200 } = request.data || {};
    if (!Number.isInteger(limit) || limit < 1 || limit > 400) {
      throw new HttpsError("invalid-argument", "limit must be an integer from 1 to 400.");
    }
    if (afterUid !== null && (typeof afterUid !== "string" || afterUid.length > 128)) {
      throw new HttpsError("invalid-argument", "Invalid pagination cursor.");
    }

    let query = db.collection("users")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(limit);
    if (afterUid) query = query.startAfter(afterUid);

    const snapshot = await query.get();
    const batch = db.batch();
    let stripped = 0;
    snapshot.docs.forEach((userDoc) => {
      if (Object.prototype.hasOwnProperty.call(userDoc.data(), "email")) {
        batch.update(userDoc.ref, { email: admin.firestore.FieldValue.delete() });
        stripped++;
      }
    });
    if (stripped > 0) await batch.commit();

    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    return {
      processed: snapshot.size,
      stripped,
      nextAfterUid: lastDoc ? lastDoc.id : null,
      done: snapshot.size < limit
    };
  }
);

/**
 * Browser audit writes are prohibited by Firestore rules. This narrow bridge
 * keeps audit events available to privileged staff until the command layer is
 * fully moved server-side; actor identity is always derived from auth.
 */
exports.writeAuditLog = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const db = admin.firestore();
    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    const mayAudit = isRuleAdmin(requester.role)
      || hasRulePermission(ctx, requester.role, "moderate_content")
      || hasRulePermission(ctx, requester.role, "manage_roles");
    if (!mayAudit) throw deny("No permission to write administrative audit records.");

    const { actionType, details = {} } = request.data || {};
    if (typeof actionType !== "string" || !/^[a-z0-9_]{3,80}$/.test(actionType)) {
      throw new HttpsError("invalid-argument", "Invalid audit action type.");
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      throw new HttpsError("invalid-argument", "Audit details must be an object.");
    }
    const serializedDetails = JSON.stringify(details);
    if (serializedDetails.length > 5000) {
      throw new HttpsError("invalid-argument", "Audit details are too large.");
    }

    await db.collection("audit_logs").add({
      action_type: actionType,
      performer_id: uid,
      actor_uid: uid,
      details,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  }
);

/**
 * createPost (Callable)
 * Replaces the client-side transaction. Mirrors the rules' canPostToTopic.
 */
exports.createPost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to post.");

    const postData = request.data || {};
    const topicId = postData.topic_id;
    const content = typeof postData.content === "string" ? postData.content.trim() : "";
    if (!topicId) throw new HttpsError("invalid-argument", "topic_id is required.");
    if (!content) throw new HttpsError("invalid-argument", "Post content is empty.");

    const topicSnap = await db.collection("topics").doc(topicId).get();
    if (!topicSnap.exists) throw new HttpsError("not-found", "Topic not found.");
    const topic = topicSnap.data();

    const requester = await getRequester(db, uid);
    if (requester.data.role_id === "pending" || requester.data.role_id === "banned") {
      throw deny("Account cannot post yet.");
    }
    const ctx = await loadContext(db);
    const isMod = isRuleAdmin(requester.role) || hasRulePermission(ctx, requester.role, "moderate_content");
    // Mods may reply in locked topics (matches the UI gate and updatePost/deletePost).
    if (!isMod && topic.is_locked) throw new HttpsError("failed-precondition", "Topic is locked.");
    if (!isMod && !hasRuleCategoryPermission(ctx, requester.role, topic.category_id, "post_reply")) {
      throw deny("No permission to reply in this category.");
    }
    if (postData.author_id && postData.author_id !== uid) throw deny("author_id mismatch.");

    const postRef = db.collection("posts").doc();
    const createdPost = {
      ...postData,
      author_id: uid,
      category_id: topic.category_id,
      topic_id: topicId,
      content,
      rolls: postData.rolls || null,
      reputation: 0,
      // Authoritative denormalised stats: the client does not send them, so a
      // fresh post doc and its RTDB mirror would otherwise show zeroed counters
      // in the author sidebar until hydrateAuthorProfiles runs on the next load.
      // post_count + 1 — onPostCreated increments the user's counter right after.
      author_posts_count: (requester.data.post_count || 0) + 1,
      author_reputation: requester.data.reputation || 0,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };
    await postRef.set(createdPost);

    const expectedCount = (topic.posts_count || 0) + 1;
    // The category row (posts_count / last_post_topic_*) is denormalised by the
    // onPostCreated trigger and read from Firestore by the projection below, so
    // wait for it to converge as well.
    const catSnap = topic.category_id ? await db.collection("categories").doc(topic.category_id).get() : null;
    const catExpectedPosts = catSnap && catSnap.exists ? ((catSnap.data().posts_count || 0) + 1) : null;
    const [topicConverged, catConverged] = await Promise.all([
      waitForRtdbConvergence(
        `main_page_cache/latest_topics/${topicId}`,
        (t) => !!t && t.last_post_id === postRef.id && t.posts_count === expectedCount
      ),
      catExpectedPosts === null ? Promise.resolve(true) : waitForRtdbConvergence(
        `main_page_cache/categories/${topic.category_id}`,
        (c) => !!c && (c.posts_count || 0) === catExpectedPosts
          && c.last_post_topic_id === topicId
          && c.last_post_topic_posts_count === expectedCount
      )
    ]);
    if (!topicConverged || !catConverged) return { success: true, postId: postRef.id, converged: false };

    return { success: true, postId: postRef.id, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * updatePost (Callable)
 * Replaces the client updateDoc. Also supports the first-post / topic edit via
 * optional topicUpdates, applying the same key whitelist per role as the rules.
 */
exports.updatePost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to edit.");

    const { postId, content, metadata = {}, topicUpdates = null } = request.data || {};
    if (!postId) throw new HttpsError("invalid-argument", "postId is required.");
    if (typeof content !== "string" || !content.trim()) {
      throw new HttpsError("invalid-argument", "Post content is empty.");
    }

    const postRef = db.collection("posts").doc(postId);
    const postSnap = await postRef.get();
    if (!postSnap.exists) throw new HttpsError("not-found", "Post not found.");
    const post = postSnap.data();

    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    const isMod = isRuleAdmin(requester.role) || hasRulePermission(ctx, requester.role, "moderate_content");
    const isAuthor = post.author_id === uid;
    if (!isMod && !isAuthor) throw deny("You can only edit your own posts.");

    // Author key whitelist — firestore.rules /posts allow update.
    const AUTHOR_POST_KEYS = ["content", "edited_at", "author_name", "author_avatar", "is_character", "author_character_id"];
    const affectedKeys = [...new Set(["content", "edited_at", ...Object.keys(metadata)])];
    if (!isMod && !affectedKeys.every((k) => AUTHOR_POST_KEYS.includes(k))) {
      throw deny("You may only edit the post content and your author identity.");
    }

    const update = { content: content.trim(), edited_at: admin.firestore.FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(metadata)) update[k] = v;
    await postRef.update(update);

    const topicRef = db.collection("topics").doc(post.topic_id);
    const topicSnap = await topicRef.get();
    if (!topicSnap.exists) throw new HttpsError("not-found", "Topic not found.");
    const topic = topicSnap.data();

    // If the edited post is the topic's last post and its author identity changed,
    // the async onPostUpdated trigger must recompute the denormalised
    // last_post_author* fields in main_page_cache before the returned projection
    // is built — otherwise the client applies stale identity data.
    let converged = true;
    // Re-read the post after the write and diff its identity against the
    // pre-write snapshot. Authoritative regardless of which metadata keys the
    // client sent — the previous per-key checks built from `metadata` could
    // miss a changed field and skip the wait entirely, returning a projection
    // built before the trigger chain had propagated the new identity.
    let postAfter = post;
    let identityChanged = false;
    const identityChecks = [];
    if (topic.last_post_id === postId) {
      postAfter = (await postRef.get()).data();
      identityChanged = (postAfter.author_name || '') !== (post.author_name || '')
        || (postAfter.author_avatar || '') !== (post.author_avatar || '')
        || !!postAfter.is_character !== !!post.is_character
        || (postAfter.author_character_id || null) !== (post.author_character_id || null);
    }
    if (identityChanged) {
      identityChecks.push(
        (t) => (t.last_post_author || '') === (postAfter.author_name || ''),
        (t) => (t.last_post_author_avatar || '') === (postAfter.author_avatar || ''),
        (t) => !!t.last_post_is_character === !!postAfter.is_character,
        (t) => (t.last_post_author_character_id || null) === (postAfter.author_character_id || null)
      );
      // The topic document is the trigger chain's source of truth: wait for it,
      // then for the latest_topics mirror the projection reads.
      converged = await waitForFirestoreConvergence(
        topicRef,
        (t) => !!t && identityChecks.every((check) => check(t))
      );
      const mirrorConverged = await waitForRtdbConvergence(
        `main_page_cache/latest_topics/${post.topic_id}`,
        (t) => !!t && t.last_post_id === postId && identityChecks.every((check) => check(t))
      );
      converged = converged && !!mirrorConverged;
    }

    // First-post / topic edit — mirrors the /topics update whitelist.
    const titleChanged = topicUpdates && typeof topicUpdates.title === "string" && topicUpdates.title !== topic.title;
    if (topicUpdates && Object.keys(topicUpdates).length > 0) {
      const isTopicAuthor = topic.author_id === uid;
      if (!isMod && !isTopicAuthor) throw deny("You can only edit your own topic.");
      if (!isMod) {
        const AUTHOR_TOPIC_KEYS = ["title", "content", "updated_at", "edited_at", "edited_by", "tags"];
        if (!Object.keys(topicUpdates).every((k) => AUTHOR_TOPIC_KEYS.includes(k))) {
          throw deny("You may only edit the topic title.");
        }
      }
      await topicRef.update({ ...topicUpdates, updated_at: admin.firestore.FieldValue.serverTimestamp() });

      // Wait for the title to converge into the main page cache if it changed.
      if (titleChanged) {
        converged = converged && (await waitForRtdbConvergence(
          `main_page_cache/latest_topics/${post.topic_id}`,
          (t) => !!t && t.title === topicUpdates.title
        ));
      }
    }

    // The category row mirrors this topic's last_post identity/title while the
    // topic is the category's newest. The trigger chain rewrites the category
    // document (Firestore, read by the projection below) after the topic mirror,
    // so wait for it too — otherwise the returned projection carries a stale
    // category row on the main page.
    const catRef = post.category_id ? db.collection("categories").doc(post.category_id) : null;
    const catSnap = catRef ? await catRef.get() : null;
    const catIsLast = !!(catSnap && catSnap.exists && catSnap.data().last_post_topic_id === post.topic_id);
    if (catIsLast && (identityChecks.length > 0 || titleChanged)) {
      // buildMainPageProjection reads the category row from the Firestore
      // document, and the RTDB mirrors can satisfy their predicates before
      // syncCategoryMetadata lands (onTopicUpdated fires from the topic write
      // inside syncTopicMetadata). Poll the source document instead.
      const catConverged = await waitForFirestoreConvergence(
        catRef,
        (c) => !!c && (c.last_post_topic_id !== post.topic_id
          || (identityChecks.every((check) => check(c))
            && (!titleChanged || c.last_post_topic_title === topicUpdates.title)))
      );
      converged = converged && catConverged;
    }

    if (!converged) return { success: true, converged: false };
    return { success: true, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * deletePost (Callable)
 * Replaces the client deleteDoc. Returns the same result shape the client used
 * to compute (incl. ghost purging), plus a converged projection.
 */
exports.deletePost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in.");

    const { postId, topicId } = request.data || {};
    if (!postId) throw new HttpsError("invalid-argument", "postId is required.");

    const postRef = db.collection("posts").doc(postId);
    const postSnap = await postRef.get();

    // Ghost post: only an RTDB cache entry remains — purge it server-side.
    if (!postSnap.exists) {
      await removePostFromRtdbCache(topicId, postId);
      await admin.database().ref(`post_voters/${postId}`).remove().catch(() => { });
      return { success: true, isGhost: true, converged: true, forum: await buildMainPageProjection(uid) };
    }
    const post = postSnap.data();

    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    const isMod = isRuleAdmin(requester.role) || hasRulePermission(ctx, requester.role, "moderate_content");
    const isAuthor = post.author_id === uid;
    if (!isMod && !isAuthor) throw deny("You can only delete your own posts.");

    const topicRef = db.collection("topics").doc(post.topic_id);
    const topicSnap = await topicRef.get();
    if (!isMod && (!topicSnap.exists || topicSnap.data().is_locked)) {
      throw new HttpsError("failed-precondition", "Topic is locked.");
    }
    const topic = topicSnap.exists ? topicSnap.data() : {};

    // Deleting a post must never take the topic with it. The first post of a
    // topic is the topic itself, so removing it is a topic-level operation and
    // must go through deleteTopics. The client used to decide this from the
    // post's index within the *current page*, which made the first post of page
    // 2+ delete the whole thread; refusing it here makes that class of bug
    // impossible regardless of what the client asks for.
    if (topic.first_post_id === postId) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot delete a topic's first post here — delete the topic instead."
      );
    }
    // Legacy topics created before first_post_id existed have no such field.
    // Fall back to an authoritative "is this the oldest post?" check so those
    // topics cannot be wiped through this path either.
    if (!topic.first_post_id) {
      const oldest = await db.collection("posts")
        .where("topic_id", "==", post.topic_id)
        .orderBy("created_at", "asc")
        .limit(1)
        .get();
      if (!oldest.empty && oldest.docs[0].id === postId) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot delete a topic's first post here — delete the topic instead."
        );
      }
    }

    const wasLast = !!topic.last_post_id && topic.last_post_id === postId;
    const expectedCount = Math.max(0, (topic.posts_count || 0) - 1);

    // Category state read before the delete so the convergence predicates can
    // assert exact post-write values.
    const catSnap = topic.category_id ? await db.collection("categories").doc(topic.category_id).get() : null;
    const catData = catSnap && catSnap.exists ? catSnap.data() : null;
    const wasCatLast = !!catData && catData.last_post_topic_id === post.topic_id;
    const catExpectedPosts = catData ? Math.max(0, (catData.posts_count || 0) - 1) : null;

    await postRef.delete();

    const [topicConverged, catConverged] = await Promise.all([
      waitForRtdbConvergence(
        `main_page_cache/latest_topics/${post.topic_id}`,
        (t) => {
          if (t === null || t === undefined) return expectedCount === 0;
          return t.posts_count === expectedCount && (!wasLast || t.last_post_id !== postId);
        }
      ),
      catExpectedPosts === null ? Promise.resolve(true) : waitForFirestoreConvergence(
        db.collection("categories").doc(topic.category_id),
        // The projection reads the category row from Firestore; its counters
        // land via the trigger's batch and its last_post_* row via the
        // subsequent syncCategoryMetadata — poll the source document.
        (c) => !!c && (c.posts_count || 0) === catExpectedPosts
          && (!wasCatLast
            || c.last_post_topic_id !== post.topic_id
            || (expectedCount > 0 && c.last_post_topic_posts_count === expectedCount))
      )
    ]);
    const converged = topicConverged && catConverged;
    if (!converged) return { success: true, isGhost: false, converged: false };
    return { success: true, isGhost: false, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * createTopic (Callable)
 * Replaces the client createTopic transaction. Mirrors the rules' canCreateTopic.
 */
exports.createTopic = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to create a topic.");

    const { topicData = {}, firstPostData = {} } = request.data || {};
    const categoryId = topicData.category_id;
    const title = typeof topicData.title === "string" ? topicData.title.trim() : "";
    const content = typeof firstPostData.content === "string" ? firstPostData.content.trim() : "";
    if (!categoryId || !title || !content) {
      throw new HttpsError("invalid-argument", "category_id, title and first-post content are required.");
    }

    const requester = await getRequester(db, uid);
    if (requester.data.role_id === "pending" || requester.data.role_id === "banned") throw deny("Account cannot create topics yet.");
    const ctx = await loadContext(db);
    if (!isRuleAdmin(requester.role) && !hasRuleCategoryPermission(ctx, requester.role, categoryId, "create_topic")) {
      throw deny("No permission to create topics here.");
    }

    const topicRef = db.collection("topics").doc();
    const postRef = db.collection("posts").doc();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    const topicDoc = {
      ...topicData,
      author_id: uid,
      views: 0,
      reputation: 0,
      created_at: timestamp,
      posts_count: 0,
      // Identifies the post that *is* the topic. Deleting it is a topic-level
      // operation, so deletePost uses this to refuse instead of cascading.
      first_post_id: postRef.id
    };
    const firstPostDoc = {
      ...firstPostData,
      topic_id: topicRef.id,
      category_id: categoryId,
      author_id: uid,
      content,
      rolls: firstPostData.rolls || null,
      reputation: 0,
      // Same denormalised author stats stamping as createPost — the client does
      // not send these and onPostCreated increments post_count right after.
      author_posts_count: (requester.data.post_count || 0) + 1,
      author_reputation: requester.data.reputation || 0,
      created_at: timestamp
    };

    // Base category counters, read before the write so the convergence predicate
    // below can assert exact post-write values (onTopicCreated and onPostCreated
    // both denormalise this category document).
    const catRef = db.collection("categories").doc(categoryId);
    const catSnap = await catRef.get();
    const catExists = catSnap.exists;
    const expectedTopics = catExists ? ((catSnap.data().topics_count || 0) + 1) : null;
    const expectedPosts = catExists ? ((catSnap.data().posts_count || 0) + 1) : null;

    await db.runTransaction(async (tx) => {
      tx.set(topicRef, topicDoc);
      tx.set(postRef, firstPostDoc);
    });

    const [topicConverged, catConverged] = await Promise.all([
      waitForRtdbConvergence(
        `main_page_cache/latest_topics/${topicRef.id}`,
        (t) => !!t && t.last_post_id === postRef.id && t.posts_count === 1
      ),
      catExists ? waitForRtdbConvergence(
        `main_page_cache/categories/${categoryId}`,
        (c) => !!c && (c.topics_count || 0) === expectedTopics
          && (c.posts_count || 0) === expectedPosts
          && c.last_post_topic_id === topicRef.id
          && c.last_post_topic_posts_count === 1
      ) : Promise.resolve(true)
    ]);
    if (!topicConverged || !catConverged) return { success: true, topicId: topicRef.id, postId: postRef.id, converged: false };
    return { success: true, topicId: topicRef.id, postId: postRef.id, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * deleteTopics (Callable)
 * Replaces the client deleteDoc loop. onTopicDeleted owns the counter/cascade
 * cleanup; this callable only performs the deletes and waits for the RTDB cache
 * to converge.
 */
exports.deleteTopics = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in.");

    const { topicIds = [] } = request.data || {};
    if (!Array.isArray(topicIds) || topicIds.length === 0) throw new HttpsError("invalid-argument", "topicIds is required.");

    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    const isMod = isRuleAdmin(requester.role) || hasRulePermission(ctx, requester.role, "moderate_content");

    // Validate every topic BEFORE deleting anything so a permission error cannot
    // leave the operation half-applied.
    const validated = [];
    for (const topicId of topicIds) {
      const topicSnap = await db.collection("topics").doc(topicId).get();
      if (!topicSnap.exists) continue;
      const topic = topicSnap.data();
      const isOwner = topic.author_id === uid && !topic.is_locked;
      if (!isMod && !isOwner) throw deny("You can only delete your own open topics.");
      validated.push({ id: topicId, title: topic.title, category_id: topic.category_id });
    }

    for (const { id } of validated) {
      await db.collection("topics").doc(id).delete();
    }

    await Promise.all(validated.map(({ id }) => waitForRtdbConvergence(
      `main_page_cache/latest_topics/${id}`,
      (t) => t === null || t === undefined
    )));

    return { success: true, deleted: validated, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * moveTopics (Callable)
 * Replaces the client moveTopics loop. onTopicUpdated recomputes category
 * metadata and moves the posts' category_id; this callable waits for the RTDB
 * cache to converge before returning the projection.
 */
exports.moveTopics = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in.");

    const { topicIds = [], targetCategoryId } = request.data || {};
    if (!Array.isArray(topicIds) || topicIds.length === 0 || !targetCategoryId) {
      throw new HttpsError("invalid-argument", "topicIds and targetCategoryId are required.");
    }

    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    if (!isRuleAdmin(requester.role) && !hasRulePermission(ctx, requester.role, "moderate_content")) {
      throw deny("Only moderators can move topics.");
    }

    const targetCatRef = db.collection("categories").doc(targetCategoryId);
    const targetCatSnap = await targetCatRef.get();
    if (!targetCatSnap.exists) throw new HttpsError("not-found", "Target category not found.");

    const moved = [];
    const waits = [];
    for (const topicId of topicIds) {
      const topicRef = db.collection("topics").doc(topicId);
      const topicSnap = await topicRef.get();
      if (!topicSnap.exists) continue;
      const topicData = topicSnap.data();
      const sourceCategoryId = topicData.category_id;
      if (sourceCategoryId === targetCategoryId) continue;
      const postsCount = topicData.posts_count || 0;

      await db.runTransaction(async (tx) => {
        tx.update(topicRef, { category_id: targetCategoryId, updated_at: admin.firestore.FieldValue.serverTimestamp() });
        if (sourceCategoryId) {
          tx.update(db.collection("categories").doc(sourceCategoryId), {
            topics_count: admin.firestore.FieldValue.increment(-1),
            posts_count: admin.firestore.FieldValue.increment(-postsCount)
          });
        }
        tx.update(targetCatRef, {
          topics_count: admin.firestore.FieldValue.increment(1),
          posts_count: admin.firestore.FieldValue.increment(postsCount)
        });
      });

      moved.push({ id: topicId, title: topicData.title, sourceCategoryId });
      waits.push(waitForRtdbConvergence(
        `main_page_cache/latest_topics/${topicId}`,
        (t) => !!t && t.category_id === targetCategoryId
      ));
    }

    await Promise.all(waits);
    return { success: true, moved, converged: true, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * movePosts (Callable)
 * Replaces the client movePosts batch. onPostUpdated recomputes topic + category
 * metadata for both ends; this callable waits for the RTDB cache to converge.
 */
exports.movePosts = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in.");

    const { postIds = [], targetTopicId } = request.data || {};
    if (!Array.isArray(postIds) || postIds.length === 0 || !targetTopicId) {
      throw new HttpsError("invalid-argument", "postIds and targetTopicId are required.");
    }

    const requester = await getRequester(db, uid);
    const ctx = await loadContext(db);
    if (!isRuleAdmin(requester.role) && !hasRulePermission(ctx, requester.role, "moderate_content")) {
      throw deny("Only moderators can move posts.");
    }

    const getTimestampMs = (ts) => {
      if (!ts) return 0;
      if (typeof ts.toMillis === "function") return ts.toMillis();
      if (typeof ts.toDate === "function") return ts.toDate().getTime();
      if (typeof ts === "number") return ts;
      if (typeof ts === "string") { const p = Date.parse(ts); return isNaN(p) ? 0 : p; }
      if (typeof ts.seconds === "number") return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6);
      return 0;
    };

    const targetTopicRef = db.collection("topics").doc(targetTopicId);
    const targetTopicSnap = await targetTopicRef.get();
    if (!targetTopicSnap.exists) throw new HttpsError("not-found", "Target topic not found.");
    const targetTopicData = targetTopicSnap.data();
    const targetCategoryId = targetTopicData.category_id;

    const targetPostsQuery = await db.collection("posts").where("topic_id", "==", targetTopicId).get();
    let targetFirstPost = null;
    let targetLatestPost = null;
    if (!targetPostsQuery.empty) {
      const list = targetPostsQuery.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => getTimestampMs(a.created_at) - getTimestampMs(b.created_at));
      targetFirstPost = list[0];
      targetLatestPost = list[list.length - 1];
    }

    const sourceMap = {};
    const movedGroups = [];
    for (const postId of postIds) {
      const postSnap = await db.collection("posts").doc(postId).get();
      if (!postSnap.exists) continue;
      const data = postSnap.data();
      if (!sourceMap[data.topic_id]) sourceMap[data.topic_id] = [];
      sourceMap[data.topic_id].push({ id: postId, ...data });
    }

    const waits = [];
    for (const [sourceTopicId, sourcePosts] of Object.entries(sourceMap)) {
      if (sourceTopicId === targetTopicId) continue;

      const count = sourcePosts.length;
      const sourceTopicRef = db.collection("topics").doc(sourceTopicId);
      const sourceTopicSnap = await sourceTopicRef.get();
      const sourceCategoryId = sourceTopicSnap.exists ? sourceTopicSnap.data().category_id : null;

      const batch = db.batch();
      const sortedSourcePosts = [...sourcePosts].sort((a, b) => getTimestampMs(a.created_at) - getTimestampMs(b.created_at));
      const targetFirstPostMs = getTimestampMs(targetFirstPost?.created_at) || getTimestampMs(targetTopicData.created_at);
      const targetLatestPostMs = getTimestampMs(targetLatestPost?.created_at) || targetFirstPostMs;
      const baseTimestampMs = Math.max(targetFirstPostMs, targetLatestPostMs);
      let nextAllowedMs = baseTimestampMs + 60 * 1000;

      for (let i = 0; i < sortedSourcePosts.length; i++) {
        const p = sortedSourcePosts[i];
        const postMs = getTimestampMs(p.created_at);
        const updates = { topic_id: targetTopicId, category_id: targetCategoryId };
        if (baseTimestampMs > 0 && (postMs <= baseTimestampMs || postMs < nextAllowedMs)) {
          updates.created_at = admin.firestore.Timestamp.fromMillis(nextAllowedMs);
          const nextP = sortedSourcePosts[i + 1];
          if (nextP) {
            const nextPMs = getTimestampMs(nextP.created_at);
            const originalDelta = (nextPMs > postMs && postMs > 0) ? (nextPMs - postMs) : 60 * 1000;
            nextAllowedMs += Math.max(60 * 1000, originalDelta);
          } else {
            nextAllowedMs += 60 * 1000;
          }
        } else {
          nextAllowedMs = postMs + 60 * 1000;
        }
        batch.update(db.collection("posts").doc(p.id), updates);
      }

      batch.update(sourceTopicRef, {
        posts_count: admin.firestore.FieldValue.increment(-count),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
      batch.update(targetTopicRef, {
        posts_count: admin.firestore.FieldValue.increment(count),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
      if (sourceCategoryId && targetCategoryId && sourceCategoryId !== targetCategoryId) {
        batch.update(db.collection("categories").doc(sourceCategoryId), { posts_count: admin.firestore.FieldValue.increment(-count) });
        batch.update(db.collection("categories").doc(targetCategoryId), { posts_count: admin.firestore.FieldValue.increment(count) });
      }
      await batch.commit();
      movedGroups.push({
        sourceTopicId,
        postIds: sortedSourcePosts.map((p) => p.id),
        count,
      });

      const srcAfter = Math.max(0, (sourceTopicSnap.exists ? (sourceTopicSnap.data().posts_count || 0) : 0) - count);
      const targetAfter = (targetTopicData.posts_count || 0) + count;

      waits.push(
        waitForRtdbConvergence(
          `main_page_cache/latest_topics/${sourceTopicId}`,
          (t) => (t === null || t === undefined) ? srcAfter === 0 : t.posts_count === srcAfter
        ),
        waitForRtdbConvergence(
          `main_page_cache/latest_topics/${targetTopicId}`,
          (t) => !!t && t.posts_count === targetAfter
        )
      );
    }

    await Promise.all(waits.flat());
    // `moved` mirrors the audit shape the client logged before the callable
    // existed: one entry per source topic, consumed by the client-side
    // `posts_moved` audit log.
    return { success: true, converged: true, moved: movedGroups, forum: await buildMainPageProjection(uid) };
  }
);

/**
 * onCategoryUpdated
 * Fires when a category document changes.
 * If permissions changed — invalidates all RTDB session_perms so the next
 * page load recalculates who can see what.
 * Also resets the server-side permissions context cache to force immediate reload.
 */
exports.onCategoryUpdated = onDocumentUpdated("categories/{categoryId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const categoryId = event.params.categoryId;

  // Compare serialised permissions to detect changes
  const permsBefore = JSON.stringify(before?.permissions || {});
  const permsAfter = JSON.stringify(after?.permissions || {});
  const permsChanged = permsBefore !== permsAfter;

  // RTDB is a server-only cache. Mirror the complete authoritative document so
  // cache data cannot keep an old permission or metadata value.
  await admin.database().ref(`main_page_cache/categories/${categoryId}`)
    .set(serialiseCategoryForRtdb(categoryId, after));

  if (permsChanged) await invalidateAllSessionPerms(`category ${categoryId} permissions changed`);
  invalidateContext();
});

exports.onCategoryCreated = onDocumentCreated("categories/{categoryId}", async (event) => {
  if (!event.data) return;
  const categoryId = event.params.categoryId;
  await admin.database().ref(`main_page_cache/categories/${categoryId}`)
    .set(serialiseCategoryForRtdb(categoryId, event.data.data()));
  invalidateContext();
  await invalidateAllSessionPerms(`category ${categoryId} created`);
});

exports.onCategoryDeleted = onDocumentDeleted("categories/{categoryId}", async (event) => {
  const categoryId = event.params.categoryId;
  await removeRtdbMainPageCategory(categoryId);
  invalidateContext();
  await invalidateAllSessionPerms(`category ${categoryId} deleted`);
});

exports.onRoleChanged = onDocumentUpdated("roles/{roleId}", async (event) => {
  invalidateContext();
  await invalidateAllSessionPerms(`role ${event.params.roleId} changed`);
});

exports.onRoleCreated = onDocumentCreated("roles/{roleId}", async (event) => {
  invalidateContext();
  await invalidateAllSessionPerms(`role ${event.params.roleId} created`);
});

exports.onRoleDeleted = onDocumentDeleted("roles/{roleId}", async (event) => {
  invalidateContext();
  await invalidateAllSessionPerms(`role ${event.params.roleId} deleted`);
});

/**
 * onTopicCreated
 * Increments topics_count for category, author, updates forum_stats/global and RTDB main_page_cache.
 */
exports.onTopicCreated = onDocumentCreated("topics/{topicId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const topic = snap.data();
  const { category_id, author_id } = topic;

  if (!category_id) {
    logger.warn(`onTopicCreated: topic ${event.params.topicId} has no category_id — skipping counter update`);
    return;
  }

  try {
    const db = admin.firestore();
    const batch = db.batch();

    // 1. Category topics_count — guard: category may have been deleted
    await queueIncrement(batch, db.collection("categories").doc(category_id), "topics_count", 1);

    // 2. User topics_count (if not guest) — guard: user may have been deleted
    if (author_id) {
      await queueIncrement(batch, db.collection("users").doc(author_id), "topics_count", 1);
    }

    // 3. Global pre-aggregated statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    batch.set(globalStatsRef, { total_topics: admin.firestore.FieldValue.increment(1) }, { merge: true });

    await batch.commit();

    // 4. Update RTDB main_page_cache
    updateRtdbMainPageCategory(category_id, {
      topics_count: admin.database.ServerValue.increment(1)
    });
    admin.database().ref('main_page_cache/stats').update({
      total_topics: admin.database.ServerValue.increment(1)
    }).catch(() => { });

    const nowMs = Date.now();
    updateRtdbLatestTopic(event.params.topicId, {
      id: event.params.topicId,
      category_id,
      title: topic.title || '',
      author_id: author_id || null,
      author_name: topic.author_name || 'User',
      author_avatar: topic.author_avatar || '',
      author_role_id: topic.author_role_id || 'player',
      posts_count: 1,
      views: 0,
      reputation: 0,
      is_pinned: !!topic.is_pinned,
      is_locked: !!topic.is_locked,
      created_at: nowMs,
      last_post_id: null,
      last_post_at: nowMs,
      last_post_author: topic.author_name || 'User',
      last_post_author_id: author_id || null,
      last_post_author_avatar: topic.author_avatar || '',
      last_post_author_role_id: topic.author_role_id || 'player',
      last_post_is_character: !!topic.is_character,
      last_post_author_character_id: topic.author_character_id || null
    });
  } catch (error) {
    logger.error(`onTopicCreated error (${event.params.topicId}):`, error);
  }
});

/**
 * onTopicUpdated
 * Handles category moves, title changes, or metadata changes on a topic.
 * Syncs category metadata and RTDB main_page_cache.
 */
exports.onTopicUpdated = onDocumentUpdated("topics/{topicId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const topicId = event.params.topicId;
  const db = admin.firestore();

  try {
    // Category-side denormalisation runs FIRST: the latest_topics mirror at the
    // bottom is the convergence signal mutation callables wait on, so it must
    // imply that the main-page category row (Firestore doc) is already fresh.
    // 1. If topic was moved to a different category
    if (before?.category_id && after?.category_id && before.category_id !== after.category_id) {
      // Posts carry category_id for security rules and server-side filtering.
      // Keep it aligned with the topic whenever moderators move a topic.
      const postsSnap = await db.collection("posts")
        .where("topic_id", "==", topicId)
        .get();
      for (let i = 0; i < postsSnap.docs.length; i += 400) {
        const batch = db.batch();
        postsSnap.docs.slice(i, i + 400).forEach(postDoc => {
          batch.update(postDoc.ref, { category_id: after.category_id });
        });
        await batch.commit();
      }
      await syncCategoryMetadata(db, before.category_id);
      await syncCategoryMetadata(db, after.category_id);
      logger.info(`onTopicUpdated: moved topic ${topicId} from category ${before.category_id} to ${after.category_id}`);
    } else if (before?.title !== after?.title || before?.last_post_at !== after?.last_post_at) {
      // 2. If title or last_post_at changed, update category's last_post if this was the last topic
      if (after?.category_id) {
        await syncCategoryMetadata(db, after.category_id);
      }
    }

    if (after) {
      const topicUpdates = {
        title: after.title || '',
        category_id: after.category_id || '',
        is_pinned: !!after.is_pinned,
        is_locked: !!after.is_locked
      };
      // Manual or profile-driven edits of the denormalised author identity
      // must reach the main page cache as well.
      if (before?.author_name !== after.author_name) topicUpdates.author_name = after.author_name || 'User';
      if (before?.author_avatar !== after.author_avatar) topicUpdates.author_avatar = after.author_avatar || '';
      if (before?.author_role_id !== after.author_role_id) topicUpdates.author_role_id = after.author_role_id || 'player';
      if (before?.last_post_author !== after.last_post_author) topicUpdates.last_post_author = after.last_post_author || 'User';
      if (before?.last_post_author_avatar !== after.last_post_author_avatar) topicUpdates.last_post_author_avatar = after.last_post_author_avatar || '';
      if (before?.last_post_author_role_id !== after.last_post_author_role_id) topicUpdates.last_post_author_role_id = after.last_post_author_role_id || 'player';
      if (after.last_post_at) {
        topicUpdates.last_post_at = after.last_post_at.toMillis
          ? after.last_post_at.toMillis()
          : (typeof after.last_post_at === 'number' ? after.last_post_at : new Date(after.last_post_at).getTime());
      }
      updateRtdbLatestTopic(topicId, topicUpdates);
    }
  } catch (err) {
    logger.error(`onTopicUpdated error (${topicId}):`, err);
  }
});

/**
 * onTopicDeleted
 * Decrements topics_count. Rollback category posts_count, updates forum_stats/global,
 * cleans up RTDB topic_posts_cache and updates main_page_cache.
 */
exports.onTopicDeleted = onDocumentDeleted("topics/{topicId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const topic = snap.data();
  const { category_id, author_id } = topic;

  try {
    const db = admin.firestore();
    // The denormalised posts_count can lag behind a just-created/deleted post.
    // Count the authoritative documents once and use that same snapshot for
    // both the aggregate decrement and the cascade deletion.
    const postsSnap = await db.collection("posts")
      .where("topic_id", "==", event.params.topicId)
      .get();
    const deletedPostsCount = postsSnap.size;
    const batch = db.batch();

    // Guard: category may have already been deleted.
    if (category_id) {
      const catRef = db.collection("categories").doc(category_id);
      const catSnap = await catRef.get();
      if (catSnap.exists) {
        batch.update(catRef, {
          topics_count: admin.firestore.FieldValue.increment(-1),
          posts_count: admin.firestore.FieldValue.increment(-deletedPostsCount)
        });
      }
    }

    // Guard: user may have been deleted
    if (author_id) {
      await queueIncrement(batch, db.collection("users").doc(author_id), "topics_count", -1);
    }

    // Every author who wrote in this topic loses post_count by the number of
    // THEIR posts that are about to disappear. onPostDeleted cannot do this: it
    // returns early for cascade posts because the topic document is already gone
    // (see the guard there), so relying on it leaves every author's post_count
    // permanently inflated after a topic deletion.
    const perAuthor = new Map();
    for (const d of postsSnap.docs) {
      const aid = d.data().author_id;
      if (!aid) continue;
      perAuthor.set(aid, (perAuthor.get(aid) || 0) + 1);
    }
    for (const [aid, n] of perAuthor) {
      await queueIncrement(batch, db.collection("users").doc(aid), "post_count", -n);
    }

    // Global pre-aggregated statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    batch.set(globalStatsRef, {
      total_topics: admin.firestore.FieldValue.increment(-1),
      total_posts: admin.firestore.FieldValue.increment(-deletedPostsCount)
    }, { merge: true });

    await batch.commit();

    // 2b. Cascade-delete posts in Firestore
    for (let i = 0; i < postsSnap.docs.length; i += 400) {
      const chunk = db.batch();
      postsSnap.docs.slice(i, i + 400).forEach(d => chunk.delete(d.ref));
      await chunk.commit();
    }
    logger.info(`onTopicDeleted: cascade-deleted ${postsSnap.size} posts for topic ${event.params.topicId}`);

    // 3. Notifications Cleanup (Chunked)
    const notifSnap = await db.collection("notifications")
      .where("payload.topic_id", "==", event.params.topicId)
      .get();

    if (!notifSnap.empty) {
      const BATCH_LIMIT = 500;
      const docs = notifSnap.docs;
      for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const chunkBatch = db.batch();
        docs.slice(i, i + BATCH_LIMIT).forEach(d => chunkBatch.delete(d.ref));
        await chunkBatch.commit();
      }
      logger.info(`onTopicDeleted: deleted ${docs.length} notifications for topic ${event.params.topicId}`);
    }

    // 3b. Reputation logs for this topic.
    // These must go: a log left behind points at a post that no longer exists,
    // and — because onReputationLogDeleted is the sole owner of the revert —
    // the voters' reputation is never taken back. The users keep permanent
    // reputation for content that is gone. Deleting the logs hands the revert
    // to that trigger, which already reverses users.reputation and drops the
    // RTDB post_voters entry.
    await deleteAllByQuery(
      db,
      db.collection("reputation_logs").where("topic_id", "==", event.params.topicId),
      `reputation_logs for topic ${event.params.topicId}`
    );

    // 3c. Subscriptions. Nothing else removes these, so they would linger as
    // rows pointing at a topic that does not exist.
    await deleteAllByQuery(
      db,
      db.collection("topic_subscriptions").where("topic_id", "==", event.params.topicId),
      `topic_subscriptions for topic ${event.params.topicId}`
    );

    // 4. Metadata Sync (Fallback)
    if (category_id) {
      await syncCategoryMetadata(db, category_id);
    }

    // 5. RTDB Updates: main_page_cache and topic_posts_cache
    if (category_id) {
      updateRtdbMainPageCategory(category_id, {
        topics_count: admin.database.ServerValue.increment(-1),
        posts_count: admin.database.ServerValue.increment(-deletedPostsCount)
      });
    }
    removeRtdbLatestTopic(event.params.topicId);
    admin.database().ref(`topic_posts_cache/${event.params.topicId}`).remove().catch(() => { });
    admin.database().ref('main_page_cache/stats').update({
      total_topics: admin.database.ServerValue.increment(-1),
      total_posts: admin.database.ServerValue.increment(-deletedPostsCount)
    }).catch(() => { });

    logger.info(`onTopicDeleted cleanup for ${event.params.topicId} successful.`);
  } catch (error) {
    logger.error(`onTopicDeleted error (${event.params.topicId}):`, error);
  }
});

/**
 * onPostCreated
 * Handles posts_count increments across topic, category, user, and forum_stats/global.
 * Syncs last_post metadata to topic and category, and mirrors to RTDB caches.
 */
exports.onPostCreated = onDocumentCreated("posts/{postId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const post = snap.data();
  const { topic_id, author_id, author_name, is_character, author_character_id, author_avatar, created_at } = post;

  try {
    const db = admin.firestore();
    const batch = db.batch();

    // Need topic title for category metadata
    const topicRef = db.collection("topics").doc(topic_id);
    const [topicSnap, settingsSnap] = await Promise.all([
      topicRef.get(),
      db.collection("settings").doc("global").get()
    ]);

    if (!topicSnap.exists) return;
    const topicData = topicSnap.data();
    const { category_id, title: topic_title, posts_count: currentTopicPostCount = 0 } = topicData;

    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const maxPostsPerTopic = settings.maxPostsPerTopic ?? 1000;
    const postsPerPage = settings.postsPerPage ?? 20;

    const newPostCount = currentTopicPostCount + 1;
    const shouldLock = newPostCount >= maxPostsPerTopic;

    const timestamp = created_at || admin.firestore.FieldValue.serverTimestamp();
    const timestampIso = (created_at?.toDate ? created_at.toDate() : new Date()).toISOString();

    // 1. Update Topic (topic is confirmed to exist above)
    const topicUpdates = {
      posts_count: admin.firestore.FieldValue.increment(1),
      last_post_at: timestamp,
      last_post_author: author_name,
      last_post_author_id: author_id || null,
      last_post_author_avatar: author_avatar || null,
      last_post_is_character: !!is_character,
      last_post_author_character_id: author_character_id || null
    };

    if (shouldLock) {
      topicUpdates.is_locked = true;
    }

    batch.update(topicRef, topicUpdates);

    // 2. Update Category — guard: category may have been deleted
    if (category_id) {
      const catRef = db.collection("categories").doc(category_id);
      const catSnap = await catRef.get();
      if (catSnap.exists) {
        batch.update(catRef, {
          posts_count: admin.firestore.FieldValue.increment(1),
          last_post_at: timestamp,
          last_post_author: author_name,
          last_post_author_id: author_id || null,
          last_post_author_avatar: author_avatar || null,
          last_post_topic_id: topic_id,
          last_post_topic_title: topic_title,
          last_post_topic_posts_count: newPostCount,
          last_post_is_character: !!is_character,
          last_post_author_character_id: author_character_id || null
        });
      }
    }

    // 3. Update User (if not guest) — guard: user may have been deleted
    if (author_id) {
      await queueIncrement(batch, db.collection("users").doc(author_id), "post_count", 1);
    }

    // 4. Global pre-aggregated statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    batch.set(globalStatsRef, { total_posts: admin.firestore.FieldValue.increment(1) }, { merge: true });

    await batch.commit();

    // 5. Mirror to RTDB Caches (main_page_cache, topic_posts_cache)
    if (category_id) {
      updateRtdbMainPageCategory(category_id, {
        posts_count: admin.database.ServerValue.increment(1),
        last_post_at: timestampIso,
        last_post_author: author_name,
        last_post_author_id: author_id || null,
        last_post_author_avatar: author_avatar || null,
        last_post_topic_id: topic_id,
        last_post_topic_title: topic_title,
        last_post_topic_posts_count: newPostCount,
        last_post_is_character: !!is_character,
        last_post_author_character_id: author_character_id || null
      });
    }

    admin.database().ref('main_page_cache/stats').update({
      total_posts: admin.database.ServerValue.increment(1)
    }).catch(() => { });

    const nowMs = Date.now();

    updateRtdbLatestTopic(topic_id, {
      id: topic_id,
      category_id,
      title: topic_title || '',
      last_post_id: event.params.postId,
      last_post_at: nowMs,
      last_post_author: author_name,
      last_post_author_id: author_id || null,
      last_post_author_avatar: author_avatar || null,
      last_post_author_role_id: post.author_role_id || 'player',
      last_post_is_character: !!is_character,
      last_post_author_character_id: author_character_id || null,
      posts_count: newPostCount
    });

    // Mirror post to topic_posts_cache (last 3 pages)
    mirrorPostToRtdbCache(
      topic_id,
      event.params.postId,
      {
        ...post,
        category_id,
        created_at: nowMs // Передаем строго текущее время сервера в ms
      },
      postsPerPage
    );

    // 6. Notifications (Background)
    await handlePostNotifications(db, {
      postId: event.params.postId,
      topicId: topic_id,
      authorId: author_id,
      authorName: author_name,
      topicTitle: topic_title,
      content: post.content
    });

  } catch (error) {
    logger.error(`onPostCreated error (${event.params.postId}):`, error);
  }
});

/**
 * onPostUpdated
 * Syncs updated post content and metadata to RTDB topic_posts_cache
 * and topic/category metadata if this was the last post.
 */
exports.onPostUpdated = onDocumentUpdated("posts/{postId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // 1. Check if post was moved to a different topic
  if (before.topic_id && after.topic_id && before.topic_id !== after.topic_id) {
    try {
      const db = admin.firestore();
      // Remove from old topic RTDB cache
      await removePostFromRtdbCache(before.topic_id, event.params.postId);
      // Mirror to new topic RTDB cache
      await mirrorPostToRtdbCache(after.topic_id, event.params.postId, after);
      // Sync topic and category metadata for both topics
      await syncTopicMetadata(db, before.topic_id);
      await syncTopicMetadata(db, after.topic_id);
      logger.info(`onPostUpdated: moved post ${event.params.postId} from topic ${before.topic_id} to ${after.topic_id}`);
      return;
    } catch (moveErr) {
      logger.error(`onPostUpdated move error for ${event.params.postId}:`, moveErr);
    }
  }

  // 2. Regular post update: update RTDB cache
  await updatePostInRtdbCache(after.topic_id, event.params.postId, {
    content: after.content || '',
    rolls: after.rolls || null,
    reputation: after.reputation || 0,
    edited_at: Date.now(),
    author_name: after.author_name || 'User',
    author_avatar: after.author_avatar || '',
    is_character: !!after.is_character,
    author_character_id: after.author_character_id || null
  });

  // 3. Check if author metadata changed
  const metadataChanged =
    before.author_name !== after.author_name ||
    before.author_avatar !== after.author_avatar ||
    before.is_character !== after.is_character ||
    before.author_character_id !== after.author_character_id;

  if (!metadataChanged) return;

  try {
    const db = admin.firestore();
    const topicId = after.topic_id;

    // Check if this post is the latest in the topic
    const latestPostSnap = await db.collection("posts")
      .where("topic_id", "==", topicId)
      .orderBy("created_at", "desc")
      .limit(1)
      .get();

    if (!latestPostSnap.empty && latestPostSnap.docs[0].id === event.params.postId) {
      await syncTopicMetadata(db, topicId);
      logger.info(`onPostUpdated: synced metadata for topic ${topicId} due to post ${event.params.postId} update`);
    }

    // Check if this post is the FIRST post (topic starter) in the topic
    const firstPostSnap = await db.collection("posts")
      .where("topic_id", "==", topicId)
      .orderBy("created_at", "asc")
      .limit(1)
      .get();

    if (!firstPostSnap.empty && firstPostSnap.docs[0].id === event.params.postId) {
      const creatorUpdates = {
        author_name: after.author_name || 'User',
        author_avatar: after.author_avatar || '',
        is_character: !!after.is_character,
        author_character_id: after.author_character_id || null
      };
      await db.collection("topics").doc(topicId).update(creatorUpdates);
      updateRtdbLatestTopic(topicId, creatorUpdates);
      logger.info(`onPostUpdated: synced creator metadata for topic ${topicId} due to first post author update`);
    }
  } catch (error) {
    logger.error(`onPostUpdated error (${event.params.postId}):`, error);
  }
});

/**
 * Extracts the forum name from global settings based on user language.
 */
function getForumNameFromSettings(settingsData, lang = 'ru') {
  if (!settingsData) return "Aerun Forum";
  const fn = settingsData.forumName;
  if (typeof fn === 'object' && fn !== null) {
    return fn[lang] || fn.ru || fn.en || "Aerun Forum";
  }
  if (typeof fn === 'string' && fn.trim()) {
    return fn.trim();
  }
  return "Aerun Forum";
}

/**
 * handlePostNotifications
 * Dispatches notifications across both Firestore and Realtime Database (RTDB).
 */
async function handlePostNotifications(db, { postId, topicId, authorId, authorName, topicTitle, content }) {
  try {
    // 1. Topic Reply Notifications (only users explicitly subscribed to the topic)
    const [subSnap, settingsSnap] = await Promise.all([
      db.collection("topic_subscriptions").where("topic_id", "==", topicId).get(),
      db.collection("settings").doc("global").get()
    ]);
    const settingsData = settingsSnap.exists ? settingsSnap.data() : {};
    const subscribers = subSnap.docs.map(d => d.data().user_id).filter(uid => uid !== authorId);

    if (subscribers.length > 0) {
      const CHUNK = 10;
      for (let i = 0; i < subscribers.length; i += CHUNK) {
        await Promise.all(subscribers.slice(i, i + CHUNK).map(async (recipientUid) => {
          try {
            const replyPayload = {
              topic_id: topicId,
              topic_title: topicTitle,
              first_post_id: postId,
              last_post_id: postId,
              post_count: 1
            };

            // Send real-time RTDB notification (0 Firestore read cost for client)
            await sendRtdbNotification(recipientUid, {
              type: "topic_reply",
              payload: replyPayload
            });

            // Check for existing unread topic_reply notification in Firestore backup
            const q = db.collection("notifications")
              .where("recipient_uid", "==", recipientUid)
              .where("type", "==", "topic_reply")
              .where("read", "==", false)
              .where("payload.topic_id", "==", topicId)
              .limit(1);

            const existingSnap = await q.get();

            const isFirstUnreadReply = existingSnap.empty;

            if (!existingSnap.empty) {
              const existingDoc = existingSnap.docs[0];
              await existingDoc.ref.update({
                "payload.post_count": admin.firestore.FieldValue.increment(1),
                "payload.last_post_id": postId,
                created_at: admin.firestore.FieldValue.serverTimestamp()
              });
            } else {
              await db.collection("notifications").add({
                recipient_uid: recipientUid,
                type: "topic_reply",
                read: false,
                archived: false,
                payload: replyPayload,
                created_at: admin.firestore.FieldValue.serverTimestamp()
              });
            }

            // Transactional email for topic reply: ONLY send for the FIRST unread reply in the topic
            if (!isFirstUnreadReply) {
              logger.info(`[Brevo Topic Reply Skipped] recipientUid=${recipientUid} already has unread notification in topic ${topicId}`);
            } else {
              try {
                const userSnap = await db.collection("users").doc(recipientUid).get();
                const uData = userSnap.exists ? userSnap.data() : {};
                const emailEnabled = uData.settings?.email_notifications?.topic_replies !== false;
                let recipientEmail = uData.email;

                if (!recipientEmail) {
                  try {
                    const authUser = await admin.auth().getUser(recipientUid);
                    recipientEmail = authUser?.email || null;
                  } catch {
                    // user might not exist in Auth
                  }
                }

                if (recipientEmail && emailEnabled) {
                  const userLang = uData.settings?.language || 'ru';
                  const dynamicForumName = getForumNameFromSettings(settingsData, userLang);
                  const postSnippet = (content || "").replace(/\[.*?\]/g, "").substring(0, 200);
                  const html = renderTopicReplyEmail({
                    recipientName: uData.nickname || "Traveler",
                    authorName: authorName || "Someone",
                    topicTitle: topicTitle || "Discussion",
                    postSnippet,
                    topicUrl: `https://aerun-forum.web.app/topic/${topicId}?postId=${postId}`,
                    forumName: dynamicForumName
                  });

                  logger.info(`[Brevo Topic Reply] Sending email to ${recipientEmail} for topic "${topicTitle}" (forumName="${dynamicForumName}")`);
                  const sendResult = await sendBrevoEmail({
                    toEmail: recipientEmail,
                    toName: uData.nickname || "Traveler",
                    subject: `New reply in: ${topicTitle || "Subscribed topic"}`,
                    htmlContent: html,
                    senderName: dynamicForumName
                  });
                  logger.info(`[Brevo Topic Reply Result] recipient=${recipientEmail} success=${sendResult?.success} result=${JSON.stringify(sendResult)}`);
                } else {
                  logger.info(`[Brevo Topic Reply Skipped] recipientUid=${recipientUid} email=${recipientEmail} emailEnabled=${emailEnabled}`);
                }
              } catch (emailErr) {
                logger.warn(`[topic reply email dispatch error] ${recipientUid}:`, emailErr);
              }
            }
          } catch (subErr) {
            logger.error(`Failed to send topic notification to ${recipientUid}:`, subErr);
          }
        }));
      }
    } // end if (subscribers.length > 0)

    // 2. Quote Notifications
    if (content) {
      const quoteRegex = /\[quote="#p([a-zA-Z0-9_-]+),t([a-zA-Z0-9_-]+),([^\]]+)"\]/gi;
      const quotedPostIds = new Set();
      let match;
      while ((match = quoteRegex.exec(content)) !== null) {
        quotedPostIds.add(match[1]);
      }

      for (const qPostId of quotedPostIds) {
        const qPostSnap = await db.collection("posts").doc(qPostId).get();
        if (qPostSnap.exists) {
          const qAuthorId = qPostSnap.data().author_id;
          if (qAuthorId && qAuthorId !== authorId) {
            const quotePayload = {
              topic_id: topicId,
              topic_title: topicTitle,
              post_id: postId
            };

            await sendRtdbNotification(qAuthorId, {
              type: "post_quoted",
              payload: quotePayload
            });

            await db.collection("notifications").add({
              recipient_uid: qAuthorId,
              type: "post_quoted",
              read: false,
              archived: false,
              payload: quotePayload,
              created_at: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    // 3. Mention Notifications
    if (content) {
      const mentionRegex = /\[b\]([^[]+)\[\/b\],/gi;
      const mentionedNames = new Set();
      let mMatch;
      while ((mMatch = mentionRegex.exec(content)) !== null) {
        mentionedNames.add(mMatch[1].trim());
      }

      if (mentionedNames.size > 0) {
        for (const name of mentionedNames) {
          let recipientUid = null;

          const userSnap = await db.collection("users").where("nickname", "==", name).limit(1).get();
          if (!userSnap.empty) {
            recipientUid = userSnap.docs[0].id;
          } else {
            const charSnap = await db.collection("characters").where("name", "==", name).limit(1).get();
            if (!charSnap.empty) {
              recipientUid = charSnap.docs[0].data().owner_id;
            }
          }

          if (recipientUid && recipientUid !== authorId) {
            const mentionPayload = {
              topic_id: topicId,
              topic_title: topicTitle,
              post_id: postId
            };

            await sendRtdbNotification(recipientUid, {
              type: "post_mentioned",
              payload: mentionPayload
            });

            const q = db.collection("notifications")
              .where("recipient_uid", "==", recipientUid)
              .where("type", "==", "post_mentioned")
              .where("payload.post_id", "==", postId)
              .limit(1);
            const existingSnap = await q.get();
            if (existingSnap.empty) {
              await db.collection("notifications").add({
                recipient_uid: recipientUid,
                type: "post_mentioned",
                read: false,
                archived: false,
                payload: mentionPayload,
                created_at: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error(`handlePostNotifications error for post ${postId}:`, err);
  }
}

/**
 * Scheduled sync of RTDB presence to Firestore users/{uid}.last_seen (every 15 minutes).
 * Performs a single batch write for all active users — 0 trigger loops!
 */
exports.syncPresenceToFirestore = onSchedule("every 15 minutes", async () => {
  try {
    const rtdb = admin.database();
    const db = admin.firestore();
    const snapshot = await rtdb.ref("status").once("value");
    const statuses = snapshot.val();
    if (!statuses) return;

    // Sync last_activity to Firestore users.last_seen.
    // last_activity is the persistent "last visited" timestamp — it is NOT reset on
    // logout or idle, so this always reflects the user's real last action.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const batch = db.batch();
    let count = 0;

    Object.keys(statuses).forEach((uid) => {
      const u = statuses[uid];
      // Prefer last_activity; fall back to last_seen for backwards compatibility
      // with records written before this field was introduced.
      const lastActivityMs = u?.last_activity ?? u?.last_seen;
      if (u && typeof lastActivityMs === 'number' && lastActivityMs > cutoff) {
        const userRef = db.collection("users").doc(uid);
        batch.set(userRef, {
          last_seen: admin.firestore.Timestamp.fromMillis(lastActivityMs)
        }, { merge: true });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      logger.info(`[syncPresenceToFirestore] Synced ${count} user last_seen records to Firestore`);
    }
  } catch (err) {
    logger.warn("[syncPresenceToFirestore error]", err);
  }
});

/**
 * onUserCreated
 * Triggers when a new user document is created.
 * Updates forum_stats/global and notifies admins via RTDB & Firestore.
 */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const newUser = snap.data();
  const db = admin.firestore();
  const rtdb = admin.database();

  try {
    // Registration is a system event, not a browser supplied audit row.
    // Keep PII out of the audit payload; email remains in Firebase Auth only.
    await db.collection("audit_logs").add({
      action_type: "user_registered",
      performer_id: event.params.uid,
      actor_uid: event.params.uid,
      details: {
        nickname: newUser.nickname || "User",
        role_id: newUser.role_id || "player"
      },
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // 1. Устанавливаем Custom Claims для мгновенных проверок Security Rules
    try {
      await admin.auth().setCustomUserClaims(event.params.uid, {
        role_id: newUser.role_id || "player"
      });
    } catch (claimErr) {
      logger.warn(`[onUserCreated] Failed to set custom claims for ${event.params.uid}:`, claimErr);
    }

    const newestUserObj = {
      id: event.params.uid,
      nickname: newUser.nickname || "User",
      avatar_url: newUser.avatar_url || "",
      role_id: newUser.role_id || "player",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };

    // 2. Обновляем глобальную статистику форума в Firestore (forum_stats/global)
    const globalStatsRef = db.collection("forum_stats").doc("global");
    await globalStatsRef.set({
      total_users: admin.firestore.FieldValue.increment(1),
      newest_user: newestUserObj
    }, { merge: true });

    // 3. Зеркалируем обновленную статистику в кэш Realtime Database для клиентов
    try {
      const globalSnap = await globalStatsRef.get();
      if (globalSnap.exists) {
        const gs = globalSnap.data();
        await rtdb.ref('main_page_cache/stats').update({
          total_users: gs.total_users ?? 0,
          newest_user_id: event.params.uid,
          newest_user_nickname: newUser.nickname || "User",
          newest_user_role_id: newUser.role_id || "player",
          updated_at: Date.now()
        });
      }
    } catch (rtdbStatsErr) {
      logger.warn(`[onUserCreated] Failed to update RTDB stats cache:`, rtdbStatsErr);
    }

    // 4. Поиск ролей с правами управления пользователями
    const rolesSnap = await db.collection("roles").get();
    const eligibleRoleIds = [];
    const USER_MGMT_PERMS = ["approve_users", "ban_users", "delete_users"];

    rolesSnap.forEach(doc => {
      const perms = (doc.data().permissions || []).map(p => String(p).toLowerCase());
      if (USER_MGMT_PERMS.some(p => perms.includes(p))) {
        eligibleRoleIds.push(doc.id);
      }
    });

    // 5. Сбор получателей уведомлений
    const recipients = new Set();
    for (let i = 0; i < eligibleRoleIds.length; i += 30) {
      const usersSnap = await db.collection("users")
        .where("role_id", "in", eligibleRoleIds.slice(i, i + 30))
        .get();
      usersSnap.forEach(u => recipients.add(u.id));
    }

    // Всегда уведомляем root
    const rootSnap = await db.collection("users").where("role_id", "==", "root").get();
    rootSnap.forEach(u => recipients.add(u.id));

    if (recipients.size === 0) return;

    let registrationEmail = null;
    try {
      registrationEmail = (await admin.auth().getUser(event.params.uid)).email || null;
    } catch (authLookupError) {
      logger.warn(`[onUserCreated] Could not resolve registration email for ${event.params.uid}:`, authLookupError);
    }

    const notifPayload = {
      uid: event.params.uid,
      nickname: newUser.nickname,
      email: registrationEmail,
      admin_message: newUser.admin_message || null
    };

    // Отправляем RTDB-уведомление админам
    await sendRtdbAdminNotification({
      type: "new_registration",
      payload: notifPayload
    });

    // 6. Создаем резервные уведомления в Firestore
    const batch = db.batch();
    recipients.forEach(uid => {
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        recipient_uid: uid,
        type: "new_registration",
        read: false,
        archived: false,
        payload: notifPayload,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await batch.commit();
  } catch (error) {
    logger.error(`onUserCreated error (${event.params.uid}):`, error);
  }
});

/**
 * onPostDeleted
 * Decrements posts_count and updates forum_stats/global.
 */
exports.onPostDeleted = onDocumentDeleted("posts/{postId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const post = snap.data();
  const { topic_id, author_id } = post;

  // 1. Очистка поста из кэша темы в RTDB
  if (topic_id) {
    await removePostFromRtdbCache(topic_id, event.params.postId);
  }

  try {
    const db = admin.firestore();
    const batch = db.batch();

    // 2. Получаем тему и категорию
    const topicRef = db.collection("topics").doc(topic_id);
    const topicSnap = await topicRef.get();

    // onTopicDeleted already removes this topic's counters before its cascade
    // deletes posts. Do not decrement them a second time for cascade events.
    if (!topicSnap.exists) {
      await admin.database().ref(`post_voters/${event.params.postId}`).remove().catch(() => { });
      logger.info(`onPostDeleted skipped counters for cascade/orphan post ${event.params.postId}`);
      return;
    }

    const { category_id } = topicSnap.data();
    await queueIncrement(batch, topicRef, "posts_count", -1);
    if (category_id) {
      await queueIncrement(batch, db.collection("categories").doc(category_id), "posts_count", -1);
    }

    if (author_id) {
      await queueIncrement(batch, db.collection("users").doc(author_id), "post_count", -1);
    }

    // Общая статистика
    const globalStatsRef = db.collection("forum_stats").doc("global");
    batch.set(globalStatsRef, { total_posts: admin.firestore.FieldValue.increment(-1) }, { merge: true });

    await batch.commit();

    // 3. Обновляем RTDB кэш статистики Главной страницы
    admin.database().ref('main_page_cache/stats').update({
      total_posts: admin.database.ServerValue.increment(-1)
    }).catch(() => { });

    // 4. Пересчитываем метаданные темы и категории в Firestore
    {
      await syncTopicMetadata(db, topic_id);

      // 5. Синхронизируем свежие метаданные категории в RTDB main_page_cache
      const categoryId = topicSnap.data()?.category_id;
      if (categoryId) {
        const updatedCatSnap = await db.collection("categories").doc(categoryId).get();
        if (updatedCatSnap.exists) {
          const cData = updatedCatSnap.data();
          await updateRtdbMainPageCategory(categoryId, {
            posts_count: cData.posts_count || 0,
            last_post_at: cData.last_post_at ? (cData.last_post_at.toDate ? cData.last_post_at.toDate().toISOString() : cData.last_post_at) : null,
            last_post_author: cData.last_post_author || null,
            last_post_author_id: cData.last_post_author_id || null,
            last_post_topic_id: cData.last_post_topic_id || null,
            last_post_topic_title: cData.last_post_topic_title || null
          });
        }
      }
    }

    // 6. Очищаем RTDB кэш оценок для удаленного поста
    admin.database().ref(`post_voters/${event.params.postId}`).remove().catch(() => { });

    logger.info(`onPostDeleted cleanup for ${event.params.postId} successful.`);
  } catch (error) {
    logger.error(`onPostDeleted error (${event.params.postId}):`, error);
  }
});

/**
 * Queues an increment onto a batch only if the target document still exists.
 * batch.update() on a missing document fails the entire commit, which is how
 * counter updates were silently lost when an author or post had been deleted.
 * Includes floor protection: decrements will never lower counter below 0.
 */
async function queueIncrement(batch, ref, field, delta) {
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (delta < 0) {
    const currentVal = snap.data()[field] || 0;
    const newVal = Math.max(0, currentVal + delta);
    batch.update(ref, { [field]: newVal });
  } else {
    batch.update(ref, { [field]: admin.firestore.FieldValue.increment(delta) });
  }
  return true;
}

/**
 * Deletes every document a query returns, in 400-doc batches, paginating so
 * that a single large topic cannot exceed the Firestore response limit.
 * Used for the collections a topic deletion has to clean up, so nothing is
 * silently left behind.
 */
async function deleteAllByQuery(db, ref, label) {
  let deleted = 0;
  while (true) {
    const snap = await ref.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;
    if (snap.docs.length < 400) break;
  }
  if (deleted) logger.info(`onTopicDeleted: deleted ${deleted} ${label}`);
  return deleted;
}

/**
 * syncTopicMetadata
 * Finds the latest post in a topic and syncs its metadata.
 * Then triggers category sync.
 */
async function syncTopicMetadata(db, topicId) {
  const topicRef = db.collection("topics").doc(topicId);
  const postSnap = await db.collection("posts")
    .where("topic_id", "==", topicId)
    .orderBy("created_at", "desc")
    .limit(1)
    .get();

  let categoryId = null;
  let tData = {};
  let lp = null;
  let lpMs = null;

  if (!postSnap.empty) {
    lp = postSnap.docs[0].data();
    lpMs = lp.created_at?.toMillis ? lp.created_at.toMillis() : (typeof lp.created_at === 'number' ? lp.created_at : (lp.created_at ? new Date(lp.created_at).getTime() : Date.now()));
    await topicRef.update({
      last_post_id: postSnap.docs[0].id,
      last_post_at: lp.created_at,
      last_post_author: lp.author_name,
      last_post_author_id: lp.author_id || null,
      last_post_author_avatar: lp.author_avatar || null,
      last_post_is_character: !!lp.is_character,
      last_post_author_character_id: lp.author_character_id || null
    });
    const topicSnap = await topicRef.get();
    tData = topicSnap.exists ? topicSnap.data() : {};
    categoryId = tData.category_id;
  } else {
    // No posts left — topic will likely be deleted by another process or trigger
    // but we'll neutralise it just in case
    await topicRef.update({ last_post_id: null, last_post_at: null, last_post_author: null });
    const topicSnap = await topicRef.get();
    tData = topicSnap.exists ? topicSnap.data() : {};
    categoryId = tData.category_id;
  }

  // The CATEGORY document must be denormalised BEFORE the topic is mirrored into
  // main_page_cache/latest_topics: mutation callables use that mirror as their
  // convergence signal, so it has to imply a fresh main-page category row too.
  // (Previously the category sync ran after the mirror, and projections built
  // right after the signal carried stale category fields.)
  if (categoryId) {
    await syncCategoryMetadata(db, categoryId);
  }

  if (lp) {
    updateRtdbLatestTopic(topicId, {
      id: topicId,
      category_id: categoryId || '',
      title: tData.title || '',
      posts_count: tData.posts_count || 1,
      last_post_id: postSnap.docs[0].id,
      last_post_at: lpMs,
      last_post_author: lp.author_name || null,
      last_post_author_id: lp.author_id || null,
      last_post_author_avatar: lp.author_avatar || null,
      last_post_is_character: !!lp.is_character,
      last_post_author_character_id: lp.author_character_id || null
    });
  } else {
    removeRtdbLatestTopic(topicId);
  }
}

/**
 * syncCategoryMetadata
 * Finds the latest active topic in a category and syncs its metadata.
 */
async function syncCategoryMetadata(db, categoryId) {
  const topicSnap = await db.collection("topics")
    .where("category_id", "==", categoryId)
    .orderBy("last_post_at", "desc")
    .limit(1)
    .get();

  const catRef = db.collection("categories").doc(categoryId);

  if (!topicSnap.empty) {
    const lt = topicSnap.docs[0].data();
    const ltId = topicSnap.docs[0].id;
    const timestampIso = lt.last_post_at ? (lt.last_post_at.toDate ? lt.last_post_at.toDate().toISOString() : lt.last_post_at) : null;
    await catRef.update({
      last_post_at: lt.last_post_at || null,
      last_post_author: lt.last_post_author || null,
      last_post_author_id: lt.last_post_author_id || null,
      last_post_author_avatar: lt.last_post_author_avatar || null,
      last_post_topic_id: ltId,
      last_post_topic_title: lt.title,
      last_post_topic_posts_count: lt.posts_count || null,
      last_post_is_character: lt.last_post_is_character || false,
      last_post_author_character_id: lt.last_post_author_character_id || null
    });
    updateRtdbMainPageCategory(categoryId, {
      last_post_at: timestampIso,
      last_post_author: lt.last_post_author || null,
      last_post_author_id: lt.last_post_author_id || null,
      last_post_author_avatar: lt.last_post_author_avatar || null,
      last_post_topic_id: ltId,
      last_post_topic_title: lt.title,
      last_post_topic_posts_count: lt.posts_count || null,
      last_post_is_character: lt.last_post_is_character || false,
      last_post_author_character_id: lt.last_post_author_character_id || null
    });
  } else {
    await catRef.update({
      last_post_at: null,
      last_post_author: null,
      last_post_author_id: null,
      last_post_author_avatar: null,
      last_post_topic_id: null,
      last_post_topic_title: null,
      last_post_is_character: null,
      last_post_author_character_id: null
    });
    updateRtdbMainPageCategory(categoryId, {
      last_post_at: null,
      last_post_author: null,
      last_post_author_id: null,
      last_post_author_avatar: null,
      last_post_topic_id: null,
      last_post_topic_title: null,
      last_post_is_character: null,
      last_post_author_character_id: null
    });
  }
}

/**
 * The main page stores a denormalised copy of the last author's identity.
 * Update only records that currently point at the changed account/character;
 * historical posts themselves deliberately remain immutable.
 */
async function syncLastPostIdentity(db, userId, characterId, identity) {
  const isCharacter = !!characterId;
  const [topicsSnap, categoriesSnap] = await Promise.all([
    db.collection("topics").where("last_post_author_id", "==", userId).get(),
    db.collection("categories").where("last_post_author_id", "==", userId).get()
  ]);

  const matchesIdentity = (data) =>
    !!data.last_post_is_character === isCharacter &&
    (!isCharacter || data.last_post_author_character_id === characterId);

  const topicDocs = topicsSnap.docs.filter(docSnap => matchesIdentity(docSnap.data()));
  const categoryDocs = categoriesSnap.docs.filter(docSnap => matchesIdentity(docSnap.data()));
  const updates = {
    last_post_author: identity.name,
    last_post_author_avatar: identity.avatar_url || null
  };
  if (identity.role_id) updates.last_post_author_role_id = identity.role_id;

  for (let i = 0; i < topicDocs.length; i += 400) {
    const batch = db.batch();
    topicDocs.slice(i, i + 400).forEach(docSnap => batch.update(docSnap.ref, updates));
    await batch.commit();
  }
  for (let i = 0; i < categoryDocs.length; i += 400) {
    const batch = db.batch();
    categoryDocs.slice(i, i + 400).forEach(docSnap => batch.update(docSnap.ref, updates));
    await batch.commit();
  }

  await Promise.all([
    ...topicDocs.map(docSnap => updateRtdbLatestTopic(docSnap.id, updates)),
    ...categoryDocs.map(docSnap => updateRtdbMainPageCategory(docSnap.id, updates))
  ]);
}

/**
 * Topic documents keep a denormalised copy of the author's account identity
 * (nickname, avatar, role). Refresh them when the account changes so older
 * topics stop showing a stale name/avatar/role on the main page.
 * Character-masked topics display the mask identity instead and are skipped.
 */
async function syncTopicAuthorIdentity(db, userId, identity) {
  const topicsSnap = await db.collection("topics")
    .where("author_id", "==", userId)
    .get();

  const topicDocs = topicsSnap.docs.filter(docSnap => docSnap.data().is_character !== true);
  if (topicDocs.length === 0) return;

  const updates = {
    author_name: identity.name,
    author_avatar: identity.avatar_url || ''
  };
  if (identity.role_id) updates.author_role_id = identity.role_id;

  for (let i = 0; i < topicDocs.length; i += 400) {
    const batch = db.batch();
    topicDocs.slice(i, i + 400).forEach(docSnap => batch.update(docSnap.ref, updates));
    await batch.commit();
  }

  await Promise.all(topicDocs.map(docSnap => updateRtdbLatestTopic(docSnap.id, updates)));
}

exports.onCharacterUpdated = onDocumentUpdated("users/{userId}/characters/{characterId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const nameChanged = before.name !== after.name;
  const avatarChanged = before.avatar_url !== after.avatar_url;
  if (!nameChanged && !avatarChanged) return;

  const { userId, characterId } = event.params;
  serverCharCache.delete(`${userId}_${characterId}`);
  try {
    await syncLastPostIdentity(admin.firestore(), userId, characterId, {
      name: after.name || "Character",
      avatar_url: after.avatar_url || ""
    });
    logger.info(`onCharacterUpdated: refreshed last-post identity for ${userId}/${characterId}`);
  } catch (err) {
    logger.error(`onCharacterUpdated identity sync error for ${userId}/${characterId}:`, err);
  }
});

exports.onUserDeleted = onDocumentDeleted("users/{userId}", async (event) => {
  const deletedUid = event.params.userId;
  try {
    const db = admin.firestore();
    const rtdb = admin.database();

    // 1. Delete from Firebase Auth
    await admin.auth().deleteUser(deletedUid).catch(err => {
      logger.warn(`Auth deletion warning for ${deletedUid}:`, err.message);
    });

    // 2. Clean up RTDB & Firestore presence/status immediately
    await Promise.allSettled([
      rtdb.ref(`status/${deletedUid}`).remove(),
      rtdb.ref(`user_presence/${deletedUid}`).remove(),
      rtdb.ref(`notifications/${deletedUid}`).remove(),
      rtdb.ref(`dm_unread/${deletedUid}`).remove(),
      db.collection("user_presence").doc(deletedUid).delete()
    ]);

    // 3. Decrement total_users with floor protection (>= 0)
    const globalStatsRef = db.collection("forum_stats").doc("global");
    let updatedTotalUsers = 0;
    let newestUserToSet = null;

    await db.runTransaction(async (t) => {
      const gSnap = await t.get(globalStatsRef);
      const gData = gSnap.exists ? gSnap.data() : {};
      const currentTotal = gData.total_users || 0;
      updatedTotalUsers = Math.max(0, currentTotal - 1);

      const updates = { total_users: updatedTotalUsers };

      // If the deleted user was the newest_user, find the new newest user
      if (gData.newest_user?.id === deletedUid) {
        const latestUserSnap = await db.collection("users")
          .orderBy("created_at", "desc")
          .limit(1)
          .get();

        if (!latestUserSnap.empty) {
          const lu = latestUserSnap.docs[0].data();
          newestUserToSet = {
            id: latestUserSnap.docs[0].id,
            nickname: lu.nickname || "User",
            avatar_url: lu.avatar_url || "",
            role_id: lu.role_id || "player",
            created_at: lu.created_at || admin.firestore.FieldValue.serverTimestamp()
          };
          updates.newest_user = newestUserToSet;
        } else {
          updates.newest_user = null;
        }
      }

      t.set(globalStatsRef, updates, { merge: true });
    });

    // 4. Mirror updated stats to RTDB
    const rtdbStatsUpdate = {
      total_users: updatedTotalUsers,
      updated_at: Date.now()
    };
    if (newestUserToSet) {
      rtdbStatsUpdate.newest_user_id = newestUserToSet.id;
      rtdbStatsUpdate.newest_user_nickname = newestUserToSet.nickname;
      rtdbStatsUpdate.newest_user_role_id = newestUserToSet.role_id;
    }
    await rtdb.ref('main_page_cache/stats').update(rtdbStatsUpdate).catch(() => { });

    logger.info(`Successfully deleted user ${deletedUid} and cleaned up presence/stats.`);
  } catch (error) {
    logger.error(`Error in onUserDeleted for ${deletedUid}:`, error);
  }
});

/**
 * Scheduled cleanup for expired user_presence documents (older than 15 minutes).
 * Deleting expired presence docs triggers onUserPresenceDeleted, setting final last_seen.
 */
exports.cleanupExpiredPresence = onSchedule("every 15 minutes", async () => {
  try {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
    const snap = await db.collection("user_presence")
      .where("last_seen", "<", cutoff)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    logger.info(`[cleanupExpiredPresence] Cleaned up ${snap.size} expired presence records`);
  } catch (err) {
    logger.error("[cleanupExpiredPresence] error", err);
  }
});

/**
 * onUserUpdated
 * Triggers when a user document is updated in Firestore.
 * Synchronizes role_id changes to Firebase Custom Claims for zero-read rules,
 * updates RTDB status/{uid}, and syncs newest_user nickname in forum stats.
 */
exports.onUserUpdated = onDocumentUpdated("users/{uid}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!after) return;
  const uid = event.params.uid;
  const db = admin.firestore();
  const rtdb = admin.database();
  const nameChanged = before?.nickname !== after.nickname;
  const avatarChanged = before?.avatar_url !== after.avatar_url;

  // The category/topic projections store the latest author's display identity,
  // and topics keep a copy of the author's name/avatar/role. Keep them current
  // when that account changes its nickname, avatar or role.
  const roleChanged = before?.role_id !== after.role_id;
  if (nameChanged || avatarChanged || roleChanged) {
    serverUserCache.delete(uid);
    try {
      const identity = {
        name: after.nickname || "User",
        avatar_url: after.avatar_url || "",
        role_id: after.role_id || "player"
      };
      await Promise.all([
        syncLastPostIdentity(db, uid, null, identity),
        syncTopicAuthorIdentity(db, uid, identity)
      ]);
      logger.info(`[onUserUpdated] Refreshed author identity for ${uid}`);
    } catch (identityErr) {
      logger.error(`[onUserUpdated] Author identity sync failed for ${uid}:`, identityErr);
    }
  }

  // 1. Sync custom claims if role changed
  if (before?.role_id !== after.role_id) {
    try {
      await admin.auth().setCustomUserClaims(uid, {
        role_id: after.role_id || "player"
      });
      logger.info(`[onUserUpdated] Synced custom claims for ${uid} to role: ${after.role_id}`);
    } catch (err) {
      logger.error(`[onUserUpdated] Failed to update custom claims for ${uid}:`, err);
    }
  }

  // 2. Sync profile updates (nickname, avatar, role, status_line, signature) to RTDB status/{uid}
  try {
    const statusUpdates = {};
    if (nameChanged && after.nickname) statusUpdates.nickname = after.nickname;
    if (avatarChanged && after.avatar_url !== undefined) statusUpdates.avatar_url = after.avatar_url;
    if (before?.role_id !== after.role_id && after.role_id) statusUpdates.role_id = after.role_id;
    if (before?.status_line !== after.status_line && after.status_line !== undefined) statusUpdates.status_line = after.status_line;
    const afterSig = after.settings?.signature ?? after.signature;
    const beforeSig = before?.settings?.signature ?? before?.signature;
    if (beforeSig !== afterSig && afterSig !== undefined) statusUpdates.signature = afterSig;

    if (Object.keys(statusUpdates).length > 0) {
      await rtdb.ref(`status/${uid}`).update(statusUpdates);
    }
  } catch (presenceErr) {
    logger.warn(`[onUserUpdated] Failed to update RTDB status for ${uid}:`, presenceErr);
  }

  // 3. Sync newest_user in global stats if this user's nickname or role was updated
  if (nameChanged || before?.role_id !== after.role_id) {
    try {
      const globalStatsRef = db.collection("forum_stats").doc("global");
      const gSnap = await globalStatsRef.get();
      if (gSnap.exists) {
        const gData = gSnap.data();
        if (gData.newest_user?.id === uid) {
          await globalStatsRef.set({
            newest_user: {
              ...gData.newest_user,
              nickname: after.nickname || gData.newest_user.nickname,
              role_id: after.role_id || gData.newest_user.role_id
            }
          }, { merge: true });

          await rtdb.ref('main_page_cache/stats').update({
            newest_user_nickname: after.nickname || "User",
            newest_user_role_id: after.role_id || "player",
            updated_at: Date.now()
          }).catch(() => { });
        }
      }
    } catch (statErr) {
      logger.warn(`[onUserUpdated] Failed to sync newest_user stats for ${uid}:`, statErr);
    }
  }
});

/**
 * getReputationLogs (Callable)
 * Retrieves reputation logs for a user, securely filtering out private logs
 * based on target user settings if the requester doesn't have permissions.
 */
exports.getReputationLogs = onCall(
  { cors: true, enforceAppCheck: false, memory: '256MB', timeoutSeconds: 60 },
  async (request) => {
    const { targetUid, page = 1, pageSize = 20, seekLogId } = request.data;
    if (!targetUid || typeof targetUid !== 'string') {
      throw new HttpsError('invalid-argument', 'targetUid must be a non-empty string');
    }

    const db = admin.firestore();
    const requesterUid = request.auth ? request.auth.uid : null;
    const isTargetUser = requesterUid === targetUid;

    const promises = [db.collection('users').doc(targetUid).get()];
    if (requesterUid) {
      promises.push(db.collection('users').doc(requesterUid).get());
    }

    const [targetUserDoc, userDoc] = await Promise.all(promises);

    const isRequesterAdmin = userDoc && userDoc.exists && ['root', 'admin'].includes(userDoc.data().role_id);
    const isRequesterModerator = userDoc && userDoc.exists && userDoc.data().role_id === 'moderator';

    if (!targetUserDoc.exists) {
      throw new HttpsError('not-found', 'Target user not found');
    }

    const targetUserData = targetUserDoc.data();
    const repShowHistory = targetUserData.settings?.rep_show_history;

    if (
      repShowHistory === false &&
      !isTargetUser &&
      !isRequesterAdmin &&
      !isRequesterModerator
    ) {
      return { hidden: true, logs: [], totalCount: 0, hasMore: false };
    }

    const query = db.collection('reputation_logs').where('target_id', '==', targetUid);
    const countSnap = await query.count().get();
    const totalCount = countSnap.data().count;

    // If seekLogId is provided, resolve which page that log falls on.
    // We fetch only the target document's timestamp, then count how many
    // of this user's logs have a LATER timestamp (i.e. come before it in
    // desc order). We do this without a composite index by fetching only
    // __name__ fields in an ordered query up to the cursor.
    let resolvedPage = page;
    if (seekLogId && typeof seekLogId === 'string') {
      try {
        const seekDoc = await db.collection('reputation_logs').doc(seekLogId).get();
        if (seekDoc.exists) {
          const seekTs = seekDoc.data().created_at;
          if (seekTs) {

            const newerSnap = await db.collection('reputation_logs')
              .where('target_id', '==', targetUid)
              .orderBy('created_at', 'desc')
              .endBefore(seekTs)
              .count()   // 1/1000 of a read per document instead of a full read each
              .get();
            resolvedPage = Math.floor(newerSnap.data().count / pageSize) + 1;
          }
        }
      } catch (seekErr) {
        // If seek fails for any reason, fall back to the requested page
        logger.warn('[getReputationLogs] seekLogId resolution failed, falling back to page', page, seekErr.message);
      }
    }

    const startIndex = (resolvedPage - 1) * pageSize;

    const logsSnapshot = await query
      .orderBy('created_at', 'desc')
      .offset(startIndex)
      .limit(pageSize)
      .get();

    const logs = [];
    const isGuest = !requesterUid;
    const repShowComments = targetUserData.settings?.rep_show_comments;
    const shouldHideComments =
      isGuest ||
      (repShowComments === false &&
        !isTargetUser &&
        !isRequesterAdmin &&
        !isRequesterModerator);

    logsSnapshot.forEach((logDoc) => {
      const logData = { id: logDoc.id, ...logDoc.data() };

      if (logData.created_at) {
        logData.created_at = logData.created_at.toDate().toISOString();
      }

      if (shouldHideComments && logData.comment && logData.voter_id !== requesterUid) {
        logData.comment = '';
      }
      logs.push(logData);
    });

    // 1. Fetch Categories and Roles for permissions
    const [categoriesSnap, rolesSnap] = await Promise.all([
      db.collection('categories').get(),
      db.collection('roles').get()
    ]);
    const categoriesMap = {};
    categoriesSnap.forEach(d => categoriesMap[d.id] = d.data());
    const rolesMap = {};
    rolesSnap.forEach(d => rolesMap[d.id] = d.data());

    // Apply pending→spectator downgrade to match AuthProvider and other callables
    let effectiveRole = 'guest';
    if (userDoc && userDoc.exists) {
      const rawRole = userDoc.data().role_id || 'guest';
      const settingsSnap = await db.collection('settings').doc('global').get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      effectiveRole = (rawRole === 'pending' && !settings.whitelistMode) ? 'spectator' : rawRole;
    }

    const hasViewPermission = (categoryId) => {
      if (effectiveRole === 'root' || effectiveRole === 'admin') return true;

      const category = categoriesMap[categoryId];
      if (!category) return false;

      const catPerms = category.permissions || {};
      const allowedRoles = catPerms['view_forum'];

      if (!allowedRoles) {
        const roleData = rolesMap[effectiveRole];
        const perms = roleData?.permissions || [];
        return perms.includes('view_forum');
      }

      if (allowedRoles.includes(effectiveRole)) return true;
      const roleData = rolesMap[effectiveRole];
      if (roleData?.base_role_id && allowedRoles.includes(roleData.base_role_id)) return true;

      return false;
    };

    // 2. Fetch Topics to check categories
    const topicIds = [...new Set(logs.map(l => l.topic_id).filter(Boolean))];
    const topicsMap = {};

    for (let i = 0; i < topicIds.length; i += 30) {
      const chunk = topicIds.slice(i, i + 30);
      const tSnap = await db.collection('topics')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      tSnap.forEach(d => topicsMap[d.id] = d.data());
    }

    // 3. Map visible logs and strip sensitive data for unauthorized topics
    const processedLogs = logs.map(log => {
      if (!log.topic_id) {
        log.isAllowed = true;
        return log;
      }

      const topic = topicsMap[log.topic_id];
      if (!topic) {
        // Topic was deleted
        log.isAllowed = false;
        log.topic_title = '';
        log.post_id = null;
        return log;
      }

      const allowed = hasViewPermission(topic.category_id);
      if (!allowed) {
        log.isAllowed = false;
        log.topic_title = '';
        log.post_id = null;
      } else {
        log.isAllowed = true;
      }
      return log;
    });

    return {
      hidden: false,
      logs: processedLogs,
      totalCount,
      page: resolvedPage,
      hasMore: totalCount > startIndex + pageSize
    };
  }
);

/**
 * getPostVoters (Callable)
 * Returns up to `limit` voters for a specific post, respecting each voter's privacy settings.
 * Anyone can call this; private users are shown as "Anonymous".
 */
exports.getPostVoters = onCall(
  { cors: true, enforceAppCheck: false, memory: '256MB', timeoutSeconds: 30 },
  async (request) => {
    const { postId, limit: reqLimit = 10 } = request.data;
    if (!postId || typeof postId !== 'string') {
      throw new HttpsError('invalid-argument', 'postId must be a non-empty string');
    }

    const db = admin.firestore();
    const requesterUid = request.auth ? request.auth.uid : null;
    const postSnap = await db.collection('posts').doc(postId).get();
    if (!postSnap.exists) throw new HttpsError('not-found', 'Post not found.');

    // post_voters used to be readable directly from RTDB, leaking vote/comment
    // data from hidden categories to anyone who knew a post id. Enforce the
    // exact forum visibility gate before even querying the reputation logs.
    const requester = await getRequester(db, requesterUid);
    const ctx = await loadContext(db);
    const postCategoryId = postSnap.data().category_id;
    if (!hasViewForum(requester.role, postCategoryId, ctx)) {
      throw deny('You do not have permission to view voters for this post.');
    }

    let isRequesterAdmin = false;
    let isRequesterModerator = false;
    if (requesterUid) {
      const userDoc = await db.collection('users').doc(requesterUid).get();
      if (userDoc.exists) {
        const role = userDoc.data().role_id;
        isRequesterAdmin = ['root', 'admin'].includes(role);
        isRequesterModerator = role === 'moderator';
      }
    }

    const maxLimit = Math.min(reqLimit, 50);

    const baseQuery = db.collection('reputation_logs').where('post_id', '==', postId);
    const [countSnap, logsSnap] = await Promise.all([
      baseQuery.count().get(),
      baseQuery.orderBy('created_at', 'desc').limit(maxLimit).get()   // needs composite index (post_id, created_at desc)
    ]);
    const total = countSnap.data().count;
    if (logsSnap.empty) return { voters: [], total };
    const sortedDocs = logsSnap.docs;   // already ordered by the query
    // Collect unique voter IDs from the slice
    const voterIds = [...new Set(sortedDocs.map(d => d.data().voter_id).filter(Boolean))];

    // Fetch voter profiles in one batch (max 30 per 'in' query)
    const voterProfiles = {};
    for (let i = 0; i < voterIds.length; i += 30) {
      const chunk = voterIds.slice(i, i + 30);
      const profilesSnap = await db.collection('users')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      profilesSnap.forEach(d => { voterProfiles[d.id] = d.data(); });
    }

    const voters = [];
    const rtdbUpdates = {};
    sortedDocs.forEach(logDoc => {
      const log = logDoc.data();
      const voterData = voterProfiles[log.voter_id];
      const showHistory = voterData?.settings?.rep_show_history;
      const isPrivate = showHistory === false
        && log.voter_id !== requesterUid
        && !isRequesterAdmin
        && !isRequesterModerator;

      const voterObj = {
        log_id: logDoc.id,
        voter_id: isPrivate ? null : log.voter_id,
        voter_nickname: isPrivate ? null : (log.voter_nickname || voterData?.nickname || 'User'),
        avatar_url: isPrivate ? null : (voterData?.avatar_url || null),
        value: log.value,
        comment: log.comment || '',
        created_at: log.created_at ? (typeof log.created_at.toDate === 'function' ? log.created_at.toDate().toISOString() : log.created_at) : null,
      };

      voters.push(voterObj);

      // Prepare backfill for RTDB
      rtdbUpdates[logDoc.id] = {
        log_id: logDoc.id,
        voter_id: isPrivate ? null : log.voter_id,
        voter_nickname: isPrivate ? null : (log.voter_nickname || voterData?.nickname || 'User'),
        avatar_url: isPrivate ? null : (voterData?.avatar_url || null),
        value: log.value,
        comment: log.comment || '',
        created_at: log.created_at ? (typeof log.created_at.toMillis === 'function' ? log.created_at.toMillis() : (typeof log.created_at.toDate === 'function' ? log.created_at.toDate().getTime() : Date.now())) : Date.now()
      };
    });

    // Asynchronously backfill RTDB cache (non-blocking)
    if (Object.keys(rtdbUpdates).length > 0) {
      admin.database().ref(`post_voters/${postId}`).update(rtdbUpdates).catch(err => {
        logger.warn(`[getPostVoters] RTDB backfill failed for ${postId}:`, err);
      });
    }

    return { voters, total };

  }
);

/**
 * Fetch posts for a topic, stripping master dice values if the user lacks VIEW_MASTER_DICE permission.
 * Checks RTDB topic_posts_cache for the last 3 pages of active topics to save Firestore reads.
 */
exports.getSecuredPosts = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { topicId, page = 1, pageSize = 20, lastVisit } = request.data;
    if (!topicId) {
      throw new HttpsError('invalid-argument', 'Missing topicId');
    }

    // 1. Fetch the topic to get category_id and posts_count
    const db = admin.firestore();
    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) {
      throw new HttpsError('not-found', 'Topic not found');
    }
    const topicData = topicDoc.data();
    const categoryId = topicData.category_id;
    const totalPosts = topicData.posts_count || 0;

    // 2. Requester role, permissions and post count (single user read)
    const uid = request.auth ? request.auth.uid : null;
    const ctx = await loadContext(db);
    const requester = await getRequester(db, uid);
    const requesterRole = requester.role;
    const userPostCount = requester.data.post_count || 0;

    let canViewMasterDice = false;
    let canBypassHideTags = false;
    if (['root', 'admin', 'moderator'].includes(requesterRole)) {
      canViewMasterDice = true;
      canBypassHideTags = true;
    } else {
      const perms = (ctx.roles[requesterRole]?.permissions) || [];
      canViewMasterDice = perms.includes('view_master_dice');
      canBypassHideTags = perms.includes('bypass_hide_tags');
    }

    // 3. Shared view_forum check
    if (!hasViewForum(requesterRole, categoryId, ctx)) {
      throw new HttpsError('permission-denied', 'You do not have permission to view posts in this category.');
    }

    let resolvedPage = 1;
    // realTotalPosts: authoritative post count from Firestore, used for page math when
    // goLast mode is active. Avoids stale posts_count causing an off-by-one empty page.
    let realTotalPosts = totalPosts;

    if (page === 'last' || page === 'latest' || page === 'unread') {
      if (lastVisit) {
        const lastVisitDate = new Date(lastVisit);
        if (!isNaN(lastVisitDate.getTime())) {
          // Count posts before AND at lastVisit (already-read posts)
          const countBeforeSnap = await db.collection('posts')
            .where('topic_id', '==', topicId)
            .where('created_at', '<=', lastVisitDate)
            .count()
            .get();
          const countBefore = countBeforeSnap.data().count;

          // Also get the real total so page math is never based on stale posts_count
          const totalCountSnap = await db.collection('posts')
            .where('topic_id', '==', topicId)
            .count()
            .get();
          realTotalPosts = totalCountSnap.data().count || totalPosts;

          if (countBefore < realTotalPosts) {
            // Jump to the page containing the first unread post
            resolvedPage = Math.max(1, Math.ceil((countBefore + 1) / pageSize));
          } else {
            // All posts already read — go to last page
            resolvedPage = Math.max(1, Math.ceil(realTotalPosts / pageSize));
          }
        } else {
          resolvedPage = Math.max(1, Math.ceil(totalPosts / pageSize));
        }
      } else {
        resolvedPage = Math.max(1, Math.ceil(totalPosts / pageSize));
      }
    } else {
      resolvedPage = parseInt(page, 10) || 1;
    }

    const startIndex = (resolvedPage - 1) * pageSize;
    const totalPages = Math.max(1, Math.ceil(realTotalPosts / pageSize));
    const isTailPage = resolvedPage >= Math.max(1, totalPages - 2);

    let rawPosts = [];
    let usedRtdbCache = false;

    // 4. Try RTDB topic_posts_cache if requesting one of the last 3 pages
    if (isTailPage && totalPosts > 0) {
      try {
        const rtdb = admin.database();
        const postsSnap = await rtdb.ref(`topic_posts_cache/${topicId}/posts`)
          .orderByChild('created_at')
          .once('value');

        if (postsSnap.exists()) {
          const cachedPosts = [];
          postsSnap.forEach(child => {
            const p = child.val();
            p.id = child.key;
            cachedPosts.push(p);
          });

          // Offset of the first cached post in global topic sequence
          const cachedStartOffset = Math.max(0, totalPosts - cachedPosts.length);
          if (startIndex >= cachedStartOffset && startIndex < totalPosts) {
            const sliceStart = startIndex - cachedStartOffset;
            const sliceEnd = sliceStart + pageSize;
            rawPosts = cachedPosts.slice(sliceStart, sliceEnd);
            if (rawPosts.length > 0) {
              usedRtdbCache = true;
            }
          }
        }
      } catch (rtdbErr) {
        logger.warn(`[getSecuredPosts RTDB cache read err for ${topicId}]`, rtdbErr);
      }
    }

    // 5. Fallback to Firestore if RTDB cache miss
    if (!usedRtdbCache || rawPosts.length === 0) {
      const postsSnap = await db.collection('posts')
        .where('topic_id', '==', topicId)
        .orderBy('created_at', 'asc')
        .offset(startIndex)
        .limit(pageSize)
        .get();

      rawPosts = [];
      postsSnap.forEach(doc => {
        const data = doc.data();
        data.id = doc.id;
        rawPosts.push(data);
      });
    }

    // Pass 1: Scan for UIDs in [hide] tags
    const addresseeUids = new Set();
    const uidScanRegex = /\[hide=@([^\]\s]+)/gi;

    rawPosts.forEach(data => {
      if (data.content && typeof data.content === 'string') {
        const isAuthor = data.author_id === uid;
        if (!canBypassHideTags && !isAuthor) {
          let scanMatch;
          while ((scanMatch = uidScanRegex.exec(data.content)) !== null) {
            addresseeUids.add(scanMatch[1]);
          }
        }
      }
    });

    // Pass 2: Batch-fetch current nicknames for all addressee UIDs
    const addresseeNicknames = {};
    if (addresseeUids.size > 0) {
      const uidArr = [...addresseeUids];
      for (let i = 0; i < uidArr.length; i += 30) {
        const chunk = uidArr.slice(i, i + 30);
        const usersSnap = await db.collection('users')
          .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
          .get();
        usersSnap.forEach(d => { addresseeNicknames[d.id] = d.data().nickname || ''; });
      }
    }

    // Pass 3: Process posts and scrub hide tags
    const posts = [];
    for (const data of rawPosts) {
      const p = { ...data };
      if (p.created_at?.toDate) {
        p.created_at = p.created_at.toDate().toISOString();
      } else if (typeof p.created_at === 'number') {
        p.created_at = new Date(p.created_at).toISOString();
      }
      if (p.updated_at?.toDate) {
        p.updated_at = p.updated_at.toDate().toISOString();
      } else if (typeof p.updated_at === 'number') {
        p.updated_at = new Date(p.updated_at).toISOString();
      }
      if (p.edited_at?.toDate) {
        p.edited_at = p.edited_at.toDate().toISOString();
      } else if (typeof p.edited_at === 'number') {
        p.edited_at = new Date(p.edited_at).toISOString();
      }

      if (p.rolls) {
        Object.keys(p.rolls).forEach(rId => {
          const roll = p.rolls[rId];
          if (roll.type === 'master' && !canViewMasterDice && p.author_id !== uid) {
            roll.value = null;
          }
        });
      }

      if (p.content && typeof p.content === 'string') {
        const isAuthor = p.author_id === uid;
        if (!canBypassHideTags && !isAuthor) {
          p.content = p.content.replace(/\[hide(?:=([^\]]+))?\]([\s\S]*?)\[\/hide\]/gi, (match, param) => {
            const fullParam = param ? param.trim() : 'hidden';
            const baseVal = fullParam.split(/\s+/)[0];
            let isVisible = false;

            if (baseVal === 'hidden') {
              isVisible = false;
            } else if (baseVal.startsWith('@')) {
              const targetUid = baseVal.substring(1);
              if (uid && uid === targetUid) isVisible = true;
            } else {
              const threshold = parseInt(baseVal, 10);
              if (!isNaN(threshold)) {
                if (userPostCount >= threshold) isVisible = true;
              } else {
                isVisible = true;
              }
            }

            if (isVisible) {
              return match;
            } else {
              const safeBase = baseVal.replace(/\]/g, '');
              let nickParam = '';
              if (safeBase.startsWith('@')) {
                const targetUid = safeBase.substring(1);
                const nick = addresseeNicknames[targetUid];
                if (nick) nickParam = ` nick="${nick.replace(/"/g, '')}"`;
              }
              return `[hide_secured=${safeBase}${nickParam}][/hide_secured]`;
            }
          });
        }
      }

      posts.push(p);
    }

    // Pinned first post
    let pinnedPost = null;
    if (topicData.first_post_pinned && resolvedPage > 1) {
      const firstPostSnap = await db.collection('posts')
        .where('topic_id', '==', topicId)
        .orderBy('created_at', 'asc')
        .limit(1)
        .get();
      if (!firstPostSnap.empty) {
        const fpData = firstPostSnap.docs[0].data();
        fpData.id = firstPostSnap.docs[0].id;
        if (fpData.created_at) fpData.created_at = fpData.created_at.toDate ? fpData.created_at.toDate().toISOString() : new Date(fpData.created_at).toISOString();
        if (fpData.updated_at) fpData.updated_at = fpData.updated_at.toDate ? fpData.updated_at.toDate().toISOString() : new Date(fpData.updated_at).toISOString();
        if (fpData.edited_at) fpData.edited_at = fpData.edited_at.toDate ? fpData.edited_at.toDate().toISOString() : new Date(fpData.edited_at).toISOString();
        pinnedPost = fpData;
      }
    }

    await hydrateAuthorProfiles(db, posts);
    if (pinnedPost) {
      await hydrateAuthorProfiles(db, [pinnedPost]);
    }

    // Latest post of the topic
    let lastPost = null;
    if (posts.length > 0 && resolvedPage === totalPages) {
      lastPost = posts[posts.length - 1];
    } else {
      const lastPostSnap = await db.collection('posts')
        .where('topic_id', '==', topicId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .get();
      if (!lastPostSnap.empty) {
        const lpData = lastPostSnap.docs[0].data();
        lpData.id = lastPostSnap.docs[0].id;
        if (lpData.created_at) lpData.created_at = lpData.created_at.toDate ? lpData.created_at.toDate().toISOString() : new Date(lpData.created_at).toISOString();
        if (lpData.updated_at) lpData.updated_at = lpData.updated_at.toDate ? lpData.updated_at.toDate().toISOString() : new Date(lpData.updated_at).toISOString();
        if (lpData.edited_at) lpData.edited_at = lpData.edited_at.toDate ? lpData.edited_at.toDate().toISOString() : new Date(lpData.edited_at).toISOString();
        lastPost = lpData;
        await hydrateAuthorProfiles(db, [lastPost]);
      }
    }

    return { posts, pinnedPost, page: resolvedPage, lastPost };
  }
);

/**
 * onDmMessageCreated
 * Triggers when a new DM message is created. Updates unread counter in RTDB (dm_unread/{recipientUid})
 * and sends a Brevo email notification if the recipient is currently offline.
 */
exports.onDmMessageCreated = onDocumentCreated("dms/{convId}/messages/{msgId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const msg = snap.data();
  const { sender_uid, text, timestamp } = msg;
  const convId = event.params.convId;

  try {
    const db = admin.firestore();
    const convDoc = await db.collection("dms").doc(convId).get();
    if (!convDoc.exists) return;
    const convData = convDoc.data();
    const participants = convData.participants || [];
    const recipientUid = participants.find(u => u !== sender_uid);

    if (!recipientUid) return;

    const rtdb = admin.database();
    const unreadRef = rtdb.ref(`dm_unread/${recipientUid}/conversations/${convId}`);

    let prevUnreadCount = 0;
    await unreadRef.transaction((current) => {
      prevUnreadCount = (current && current.unread_count) || 0;
      return {
        unread_count: prevUnreadCount + 1,
        last_message: (text || '').substring(0, 100),
        sender_uid: sender_uid,
        timestamp: timestamp?.toMillis ? timestamp.toMillis() : Date.now()
      };
    });

    const convsSnap = await rtdb.ref(`dm_unread/${recipientUid}/conversations`).once('value');
    let total = 0;
    convsSnap.forEach(child => {
      total += (child.val()?.unread_count || 0);
    });
    await rtdb.ref(`dm_unread/${recipientUid}/total`).set(total);

    // Only send DM email notification for the FIRST unread message in this conversation!
    if (prevUnreadCount > 0) {
      logger.info(`[Brevo DM Email Skipped] recipientUid=${recipientUid} already has ${prevUnreadCount} unread DM(s) in conversation ${convId}`);
      return;
    }

    // Check if recipient should receive email notification
    try {
      const [presenceSnap, recipientDoc, senderDoc, settingsDoc] = await Promise.all([
        rtdb.ref(`status/${recipientUid}`).once('value'),
        db.collection("users").doc(recipientUid).get(),
        db.collection("users").doc(sender_uid).get(),
        db.collection("settings").doc("global").get()
      ]);

      const rData = recipientDoc.exists ? recipientDoc.data() : {};
      const settingsData = settingsDoc.exists ? settingsDoc.data() : {};
      const emailNotificationsEnabled = rData.settings?.email_notifications?.dms !== false;
      let recipientEmail = rData.email;

      if (!recipientEmail) {
        try {
          const authUser = await admin.auth().getUser(recipientUid);
          recipientEmail = authUser?.email || null;
        } catch {
          // user not in Auth
        }
      }

      if (recipientEmail && emailNotificationsEnabled) {
        const pVal = presenceSnap.val();
        const lastSeen = pVal?.last_seen || pVal?.last_activity || 0;
        const ONLINE_WINDOW_MS = 15 * 60 * 1000;
        const isOffline = !pVal || pVal.state !== 'online' || (Date.now() - lastSeen > ONLINE_WINDOW_MS);

        if (isOffline) {
          const userLang = rData.settings?.language || 'ru';
          const dynamicForumName = getForumNameFromSettings(settingsData, userLang);
          const senderNick = (senderDoc.exists ? senderDoc.data().nickname : null) || "A forum member";
          const messageSnippet = (text || "").substring(0, 150);
          const html = renderDmNotificationEmail({
            recipientName: rData.nickname || "Traveler",
            senderName: senderNick,
            messageSnippet,
            forumUrl: "https://aerun-forum.web.app",
            forumName: dynamicForumName
          });

          logger.info(`[Brevo DM Email] Dispatching email to ${recipientEmail} from ${senderNick} (conv=${convId}, forumName="${dynamicForumName}")`);
          const sendResult = await sendBrevoEmail({
            toEmail: recipientEmail,
            toName: rData.nickname || "Traveler",
            subject: `New direct message from ${senderNick}`,
            htmlContent: html,
            senderName: dynamicForumName
          });
          logger.info(`[Brevo DM Email Result] recipient=${recipientEmail} success=${sendResult?.success} result=${JSON.stringify(sendResult)}`);
        } else {
          logger.info(`[Brevo DM Email Skipped] recipient=${recipientEmail} is currently active/online in forum (state=${pVal?.state})`);
        }
      } else {
        logger.info(`[Brevo DM Email Skipped] recipientUid=${recipientUid} email=${recipientEmail} emailEnabled=${emailNotificationsEnabled}`);
      }
    } catch (emailErr) {
      logger.warn(`[onDmMessageCreated email notification err] ${recipientUid}:`, emailErr);
    }

  } catch (err) {
    logger.error(`[onDmMessageCreated] conv=${convId} err:`, err);
  }
});

/**
 * Scheduled sync of forum stats to RTDB main_page_cache/stats (every 2 hours).
 */
exports.syncForumStatsToRtdb = onSchedule("every 2 hours", async () => {
  try {
    const db = admin.firestore();
    const rtdb = admin.database();
    const globalStatsSnap = await db.collection("forum_stats").doc("global").get();
    if (globalStatsSnap.exists) {
      const gs = globalStatsSnap.data();
      const statsPayload = {
        total_topics: gs.total_topics ?? 0,
        total_posts: gs.total_posts ?? 0,
        total_users: gs.total_users ?? 0,
        newest_user_id: gs.newest_user?.id || null,
        newest_user_nickname: gs.newest_user?.nickname || null,
        newest_user_role_id: gs.newest_user?.role_id || null,
        updated_at: Date.now()
      };
      await rtdb.ref("main_page_cache/stats").set(statsPayload);
      logger.info("[syncForumStatsToRtdb] Synced stats to RTDB");
    }
  } catch (err) {
    logger.warn("[syncForumStatsToRtdb err]", err);
  }
});

/**
 * Scheduled cleanup of stale topic posts cache (>24h since last activity).
 */
exports.cleanupStaleTopicPostsCache = onSchedule("every 1 hours", async () => {
  try {
    const rtdb = admin.database();
    const cacheSnap = await rtdb.ref("topic_posts_cache").once("value");
    if (!cacheSnap.exists()) return;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const removals = [];

    cacheSnap.forEach(child => {
      const meta = child.child("meta").val();
      if (meta && meta.last_post_at && meta.last_post_at < cutoff) {
        removals.push(child.ref.remove());
      }
    });

    if (removals.length > 0) {
      await Promise.all(removals);
      logger.info(`[cleanupStaleTopicPostsCache] Cleaned up ${removals.length} stale topic post caches`);
    }

    // 2. Cleanup stale post_voters cache (entries with no activity >48h)
    const votersSnap = await rtdb.ref("post_voters").once("value");
    if (votersSnap.exists()) {
      const votersCutoff = Date.now() - 48 * 60 * 60 * 1000;
      const voterRemovals = [];
      votersSnap.forEach(postChild => {
        let maxTime = 0;
        postChild.forEach(logChild => {
          const t = logChild.child("created_at").val();
          if (typeof t === 'number' && t > maxTime) maxTime = t;
        });
        if (!maxTime || maxTime < votersCutoff) {
          voterRemovals.push(postChild.ref.remove());
        }
      });
      if (voterRemovals.length > 0) {
        await Promise.all(voterRemovals);
        logger.info(`[cleanupStaleTopicPostsCache] Cleaned up ${voterRemovals.length} stale post_voters caches`);
      }
    }
  } catch (err) {
    logger.warn("[cleanupStaleTopicPostsCache err]", err);
  }
});

/**
 * getUserPosts (Callable)
 * Securely retrieves posts by a specific user across all topics.
 * Filters results on the server based on the requester's permissions for each category.
 */
exports.getUserPosts = onCall(
  { cors: true, enforceAppCheck: false, memory: '256MB', timeoutSeconds: 60 },
  async (request) => {
    const { targetUid, page = 1, pageSize = 20, postFilter = 'all' } = request.data;

    if (!targetUid || typeof targetUid !== 'string') {
      throw new HttpsError('invalid-argument', 'targetUid must be a non-empty string');
    }

    const db = admin.firestore();
    const requesterUid = request.auth ? request.auth.uid : null;

    // 1. Load requester role and global settings
    let requesterRole = 'guest';
    let isRestricted = false;
    if (requesterUid) {
      const userDoc = await db.collection("users").doc(requesterUid).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        requesterRole = userData.role_id || 'player';
        if (requesterRole === 'pending') isRestricted = true;
      }
    }

    const settingsSnap = await db.collection("settings").doc("global").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const isWhitelistOff = !settings.whitelistMode;

    // 2. Determine effective role (matching AuthProvider.jsx logic)
    let effectiveRole = requesterRole;
    if (isRestricted && isWhitelistOff) {
      effectiveRole = 'spectator';
    }

    // 3. Load roles and categories for permission checking
    const [rolesSnap, categoriesSnap] = await Promise.all([
      db.collection("roles").get(),
      db.collection("categories").get()
    ]);

    const rolesMap = {};
    rolesSnap.forEach(d => rolesMap[d.id] = d.data());

    const categoriesMap = {};
    categoriesSnap.forEach(d => categoriesMap[d.id] = d.data());

    // 4. Helper to check VIEW_FORUM permission
    const hasViewPermission = (categoryId) => {
      if (effectiveRole === 'root' || effectiveRole === 'admin') return true;

      const category = categoriesMap[categoryId];
      if (!category) return false;

      const catPerms = category.permissions || {};
      const allowedRoles = catPerms['view_forum'];

      if (!allowedRoles) {
        // No override, use global role permissions
        const roleData = rolesMap[effectiveRole];
        const perms = roleData?.permissions || [];
        return perms.includes('view_forum');
      }

      // Category override exists
      if (allowedRoles.includes(effectiveRole)) return true;
      // Check inheritance
      const roleData = rolesMap[effectiveRole];
      if (roleData?.base_role_id && allowedRoles.includes(roleData.base_role_id)) return true;

      return false;
    };

    // 5. Build base query with optional character filter
    let baseQuery = db.collection('posts').where('author_id', '==', targetUid);

    if (postFilter === 'account') {
      baseQuery = baseQuery.where('is_character', '==', false);
    } else if (postFilter.startsWith('char_')) {
      const charId = postFilter.replace('char_', '');
      baseQuery = baseQuery.where('is_character', '==', true).where('author_character_id', '==', charId);
    }

    // 5a. Get total count for pagination UI
    const countSnap = await baseQuery.count().get();
    const totalCount = countSnap.data().count;

    if (totalCount === 0) {
      return { posts: [], totalCount: 0, hasMore: false };
    }

    const startIndex = (page - 1) * pageSize;

    // 5b. Fetch only the current page
    const postsSnap = await baseQuery
      .orderBy('created_at', 'desc')
      .offset(startIndex)
      .limit(pageSize)
      .get();

    if (postsSnap.empty) {
      return { posts: [], totalCount, hasMore: false };
    }

    // 6. Get unique topics to find their categories
    const topicIds = [...new Set(postsSnap.docs.map(d => d.data().topic_id))];
    const topicsMap = {};

    // Fetch topics in chunks of 30 (Firestore IN limit)
    for (let i = 0; i < topicIds.length; i += 30) {
      const chunk = topicIds.slice(i, i + 30);
      const tSnap = await db.collection('topics')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      tSnap.forEach(d => topicsMap[d.id] = d.data());
    }

    // 7. Filter visible posts by category permission
    const visiblePosts = [];
    postsSnap.forEach(doc => {
      const data = doc.data();
      const topic = topicsMap[data.topic_id];
      if (topic && hasViewPermission(topic.category_id)) {
        const cleanPost = {
          id: doc.id,
          ...data,
          topic_title: topic.title,
          category_id: topic.category_id
        };
        if (cleanPost.created_at) cleanPost.created_at = cleanPost.created_at.toDate().toISOString();
        if (cleanPost.updated_at) cleanPost.updated_at = cleanPost.updated_at.toDate().toISOString();
        if (cleanPost.edited_at) cleanPost.edited_at = cleanPost.edited_at.toDate().toISOString();
        visiblePosts.push(cleanPost);
      }
    });

    await hydrateAuthorProfiles(db, visiblePosts);

    return {
      posts: visiblePosts,
      totalCount,
      hasMore: totalCount > startIndex + pageSize
    };
  }
);


/**
 * deleteGhostPost (Callable)
 * Очищает кэш RTDB для поста-призрака, который уже был удален из Firestore.
 */
exports.deleteGhostPost = onCall(
  { cors: true, enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { topicId, postId } = request.data;
    if (!topicId || !postId) return { success: false };

    try {
      await removePostFromRtdbCache(topicId, postId);
      logger.info(`[deleteGhostPost] Successfully purged ghost post ${postId} from topic ${topicId}`);
      return { success: true };
    } catch (err) {
      logger.error(`[deleteGhostPost] Error purging ${postId}:`, err);
      return { success: false };
    }
  }
);
