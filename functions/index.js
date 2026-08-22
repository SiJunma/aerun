const { loadContext, hasViewForum, getRequester } = require("./permissions");
const { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

// Ensure only a reasonable amount of instances run at once to manage billing safely
setGlobalOptions({ maxInstances: 10, enforceAppCheck: true, memory: "512MiB" });

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

async function getSessionPerms(db, uid, userRole) {
  const rtdb = admin.database();
  const key = uid || 'guest';
  const permsRef = rtdb.ref(`session_perms/${key}`);

  try {
    const snap = await permsRef.once('value');
    const cached = snap.val();
    const now = Date.now();
    if (cached && cached.expires_at > now && cached.role_id === userRole) {
      return new Set(cached.allowed_category_ids || []);
    }
  } catch (err) {
    logger.warn('[getSessionPerms read err]', err);
  }

  // Calculate permissions
  const ctx = await loadContext(db);
  const allowed = [];
  Object.keys(ctx.categories).forEach(catId => {
    if (hasViewForum(userRole, catId, ctx)) {
      allowed.push(catId);
    }
  });

  const expiresAt = Date.now() + (uid ? 30 * 60 * 1000 : 60 * 60 * 1000);
  permsRef.set({
    allowed_category_ids: allowed,
    role_id: userRole,
    expires_at: expiresAt
  }).catch(() => { });

  return new Set(allowed);
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
    const batch = db.batch();

    // batch.update() on a missing document aborts the WHOLE commit, and both
    // the post and the user may already be gone by the time this fires.
    const userQueued = await queueIncrement(batch, db.collection("users").doc(target_id), "reputation", -value);
    if (post_id) {
      await queueIncrement(batch, db.collection("posts").doc(post_id), "reputation", -value);
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
 * locatePost (Callable)
 * Resolves the page number of a given post inside a topic.
 */
exports.locatePost = onCall(
  { enforceAppCheck: false, minInstances: 0 },
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
  { enforceAppCheck: false, minInstances: 0 },
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
  { enforceAppCheck: false, minInstances: 0 },
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
        item.author_signature = u.signature !== undefined ? u.signature : (item.author_signature || '');
        item.author_posts_count = u.post_count !== undefined ? u.post_count : (item.author_posts_count || 0);
        item.author_reputation = u.reputation !== undefined ? u.reputation : (item.author_reputation || 0);

        if (!item.is_character) {
          if (u.nickname) item.author_name = u.nickname;
          if (u.avatar_url) item.author_avatar = u.avatar_url;
        }
      }

      if (item.is_character && item.author_id && item.author_character_id) {
        const key = `${item.author_id}_${item.author_character_id}`;
        if (charProfiles[key]) {
          const c = charProfiles[key];
          if (c.name) item.author_name = c.name;
          if (c.avatar_url) item.author_avatar = c.avatar_url;
        }
      }

      if (item.last_post_author_id && userProfiles[item.last_post_author_id]) {
        const u = userProfiles[item.last_post_author_id];
        if (!item.last_post_is_character) {
          if (u.nickname) item.last_post_author = u.nickname;
          if (u.avatar_url) item.last_post_author_avatar = u.avatar_url;
        }
      }

      if (item.last_post_is_character && item.last_post_author_id && item.last_post_author_character_id) {
        const key = `${item.last_post_author_id}_${item.last_post_author_character_id}`;
        if (charProfiles[key]) {
          const c = charProfiles[key];
          if (c.name) item.last_post_author = c.name;
          if (c.avatar_url) item.last_post_author_avatar = c.avatar_url;
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
  { enforceAppCheck: false, minInstances: 0 },
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
  { enforceAppCheck: false, minInstances: 0 },
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
 * getSecuredMainPageData (Callable)
 * Combines categories and forum statistics into a single unified payload.
 * Reads primarily from RTDB main_page_cache with zero Firestore reads,
 * filters via session_perms, and falls back to Firestore on first run.
 */
exports.getSecuredMainPageData = onCall(
  { enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const db = admin.firestore();
    const uid = request.auth ? request.auth.uid : null;
    const requester = await getRequester(db, uid);
    const rtdb = admin.database();

    // 1. Check RTDB main_page_cache
    let rtdbCategories = null;
    let rtdbStats = null;

    try {
      const [catSnap, statsSnap] = await Promise.all([
        rtdb.ref('main_page_cache/categories').once('value'),
        rtdb.ref('main_page_cache/stats').once('value')
      ]);
      rtdbCategories = catSnap.val();
      rtdbStats = statsSnap.val();
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

    // 2. Filter allowed categories using session_perms
    const allowedCatIds = await getSessionPerms(db, uid, requester.role);

    const categories = Object.values(rtdbCategories)
      .filter(cat => allowedCatIds.has(cat.id))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

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

    return { categories, latestTopics: [], stats, dailyActiveUsers: [] };
  }
);

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
  } catch (error) {
    logger.error(`onTopicCreated error (${event.params.topicId}):`, error);
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
  const { category_id, author_id, posts_count = 0 } = topic;

  try {
    const db = admin.firestore();
    const batch = db.batch();

    // Guard: category may have already been deleted.
    if (category_id) {
      const catRef = db.collection("categories").doc(category_id);
      const catExists = await queueIncrement(batch, catRef, "topics_count", -1);
      if (catExists) {
        batch.update(catRef, {
          posts_count: admin.firestore.FieldValue.increment(-posts_count)
        });
      }
    }

    // Guard: user may have been deleted
    if (author_id) {
      await queueIncrement(batch, db.collection("users").doc(author_id), "topics_count", -1);
    }

    // Global pre-aggregated statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    batch.set(globalStatsRef, {
      total_topics: admin.firestore.FieldValue.increment(-1),
      total_posts: admin.firestore.FieldValue.increment(-posts_count)
    }, { merge: true });

    await batch.commit();

    // 2b. Cascade-delete posts in Firestore
    const postsSnap = await db.collection("posts")
      .where("topic_id", "==", event.params.topicId)
      .get();
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

    // 4. Metadata Sync (Fallback)
    if (category_id) {
      await syncCategoryMetadata(db, category_id);
    }

    // 5. RTDB Updates: main_page_cache and topic_posts_cache
    if (category_id) {
      updateRtdbMainPageCategory(category_id, {
        topics_count: admin.database.ServerValue.increment(-1),
        posts_count: admin.database.ServerValue.increment(-posts_count)
      });
    }
    admin.database().ref(`topic_posts_cache/${event.params.topicId}`).remove().catch(() => { });
    admin.database().ref('main_page_cache/stats').update({
      total_topics: admin.database.ServerValue.increment(-1),
      total_posts: admin.database.ServerValue.increment(-posts_count)
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
  } catch (error) {
    logger.error(`onPostUpdated error (${event.params.postId}):`, error);
  }
});

/**
 * handlePostNotifications
 * Dispatches notifications across both Firestore and Realtime Database (RTDB).
 */
async function handlePostNotifications(db, { postId, topicId, authorId, topicTitle, content }) {
  try {
    // 1. Topic Reply Notifications
    const subSnap = await db.collection("topic_subscriptions").where("topic_id", "==", topicId).get();
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
      const mentionRegex = /\[b\]([^\[]+)\[\/b\],/gi;
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

  try {
    // Update global forum statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    await globalStatsRef.set({
      total_users: admin.firestore.FieldValue.increment(1),
      newest_user: {
        id: event.params.uid,
        nickname: newUser.nickname || "User",
        avatar_url: newUser.avatar_url || "",
        role_id: newUser.role_id || "player",
        created_at: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    // 1. Find roles with user-management permissions
    const rolesSnap = await db.collection("roles").get();
    const eligibleRoleIds = [];
    const USER_MGMT_PERMS = ["approve_users", "ban_users", "delete_users"];

    rolesSnap.forEach(doc => {
      const perms = (doc.data().permissions || []).map(p => String(p).toLowerCase());
      if (USER_MGMT_PERMS.some(p => perms.includes(p))) {
        eligibleRoleIds.push(doc.id);
      }
    });

    // 2. Collect recipients
    const recipients = new Set();
    for (let i = 0; i < eligibleRoleIds.length; i += 30) {
      const usersSnap = await db.collection("users")
        .where("role_id", "in", eligibleRoleIds.slice(i, i + 30))
        .get();
      usersSnap.forEach(u => recipients.add(u.id));
    }

    // Always notify role_id === 'root'
    const rootSnap = await db.collection("users").where("role_id", "==", "root").get();
    rootSnap.forEach(u => recipients.add(u.id));

    if (recipients.size === 0) return;

    const notifPayload = {
      uid: event.params.uid,
      nickname: newUser.nickname,
      email: newUser.email,
      admin_message: newUser.admin_message || null
    };

    // Send real-time RTDB admin notification
    await sendRtdbAdminNotification({
      type: "new_registration",
      payload: notifPayload
    });

    // 3. Create notifications in Firestore backup
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

    if (topicSnap.exists) {
      const { category_id } = topicSnap.data();
      batch.update(topicRef, { posts_count: admin.firestore.FieldValue.increment(-1) });
      batch.update(db.collection("categories").doc(category_id), { posts_count: admin.firestore.FieldValue.increment(-1) });
    }

    if (author_id) {
      batch.update(db.collection("users").doc(author_id), { post_count: admin.firestore.FieldValue.increment(-1) });
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
    if (topicSnap.exists) {
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

    logger.info(`onPostDeleted cleanup for ${event.params.postId} successful.`);
  } catch (error) {
    logger.error(`onPostDeleted error (${event.params.postId}):`, error);
  }
});

/**
 * Queues an increment onto a batch only if the target document still exists.
 * batch.update() on a missing document fails the entire commit, which is how
 * counter updates were silently lost when an author or post had been deleted.
 */
async function queueIncrement(batch, ref, field, delta) {
  const snap = await ref.get();
  if (!snap.exists) return false;
  batch.update(ref, { [field]: admin.firestore.FieldValue.increment(delta) });
  return true;
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

  if (!postSnap.empty) {
    const lp = postSnap.docs[0].data();
    await topicRef.update({
      last_post_at: lp.created_at,
      last_post_author: lp.author_name,
      last_post_author_id: lp.author_id || null,
      last_post_author_avatar: lp.author_avatar || null,
      last_post_is_character: !!lp.is_character,
      last_post_author_character_id: lp.author_character_id || null
    });
    const topicSnap = await topicRef.get();
    categoryId = topicSnap.data()?.category_id;
  } else {
    // No posts left — topic will likely be deleted by another process or trigger
    // but we'll neutralise it just in case
    await topicRef.update({ last_post_at: null, last_post_author: null });
  }

  if (categoryId) {
    await syncCategoryMetadata(db, categoryId);
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

exports.onUserDeleted = onDocumentDeleted("users/{userId}", async (event) => {
  const deletedUid = event.params.userId;
  try {
    await admin.auth().deleteUser(deletedUid);
    const db = admin.firestore();
    await db.collection("forum_stats").doc("global").set({
      total_users: admin.firestore.FieldValue.increment(-1)
    }, { merge: true });
    logger.info(`Successfully deleted auth user: ${deletedUid}`);
  } catch (error) {
    logger.error(`Error deleting auth user ${deletedUid}:`, error);
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
 * onUserCreated
 * Triggers when a new user document is created.
 * Updates forum_stats/global and notifies admins.
 */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const newUser = snap.data();
  const db = admin.firestore();

  try {
    // Update global forum statistics
    const globalStatsRef = db.collection("forum_stats").doc("global");
    await globalStatsRef.set({
      total_users: admin.firestore.FieldValue.increment(1),
      newest_user: {
        id: event.params.uid,
        nickname: newUser.nickname || "User",
        avatar_url: newUser.avatar_url || "",
        role_id: newUser.role_id || "player",
        created_at: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    // 1. Find roles with user-management permissions
    const rolesSnap = await db.collection("roles").get();
    const eligibleRoleIds = [];
    const USER_MGMT_PERMS = ["approve_users", "ban_users", "delete_users"];

    rolesSnap.forEach(doc => {
      const perms = (doc.data().permissions || []).map(p => String(p).toLowerCase());
      if (USER_MGMT_PERMS.some(p => perms.includes(p))) {
        eligibleRoleIds.push(doc.id);
      }
    });

    // 2. Collect recipients
    const recipients = new Set();
    for (let i = 0; i < eligibleRoleIds.length; i += 30) {
      const usersSnap = await db.collection("users")
        .where("role_id", "in", eligibleRoleIds.slice(i, i + 30))
        .get();
      usersSnap.forEach(u => recipients.add(u.id));
    }

    // Always notify role_id === 'root'
    const rootSnap = await db.collection("users").where("role_id", "==", "root").get();
    rootSnap.forEach(u => recipients.add(u.id));

    if (recipients.size === 0) return;

    // 3. Create notifications
    const batch = db.batch();
    recipients.forEach(uid => {
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        recipient_uid: uid,
        type: "new_registration",
        read: false,
        archived: false,
        payload: {
          uid: event.params.uid,
          nickname: newUser.nickname,
          email: newUser.email,
          admin_message: newUser.admin_message || null
        },
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await batch.commit();
  } catch (error) {
    logger.error(`onUserCreated error (${event.params.uid}):`, error);
  }
});

/**
 * getReputationLogs (Callable)
 * Retrieves reputation logs for a user, securely filtering out private logs
 * based on target user settings if the requester doesn't have permissions.
 */
exports.getReputationLogs = onCall(
  { memory: '256MB', timeoutSeconds: 60 },
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
  { memory: '256MB', timeoutSeconds: 30 },
  async (request) => {
    const { postId, limit: reqLimit = 10 } = request.data;
    if (!postId || typeof postId !== 'string') {
      throw new HttpsError('invalid-argument', 'postId must be a non-empty string');
    }

    const db = admin.firestore();
    const requesterUid = request.auth ? request.auth.uid : null;

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
    sortedDocs.forEach(logDoc => {
      const log = logDoc.data();
      const voterData = voterProfiles[log.voter_id];
      const showHistory = voterData?.settings?.rep_show_history;
      const isPrivate = showHistory === false
        && log.voter_id !== requesterUid
        && !isRequesterAdmin
        && !isRequesterModerator;

      voters.push({
        voter_id: isPrivate ? null : log.voter_id,
        voter_nickname: isPrivate ? null : (log.voter_nickname || voterData?.nickname || 'User'),
        value: log.value,
        created_at: log.created_at ? log.created_at.toDate().toISOString() : null,
      });
    });

    return { voters, total };

  }
);

/**
 * Fetch posts for a topic, stripping master dice values if the user lacks VIEW_MASTER_DICE permission.
 * Checks RTDB topic_posts_cache for the last 3 pages of active topics to save Firestore reads.
 */
exports.getSecuredPosts = onCall(
  { enforceAppCheck: false, minInstances: 0 },
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
 * Triggers when a new DM message is created. Updates unread counter in RTDB (dm_unread/{recipientUid}).
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

    await unreadRef.transaction((current) => {
      const prevCount = (current && current.unread_count) || 0;
      return {
        unread_count: prevCount + 1,
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
  { memory: '256MB', timeoutSeconds: 60 },
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
  { enforceAppCheck: false, minInstances: 0 },
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