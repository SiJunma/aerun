const { loadContext, hasViewForum, getRequester } = require("./permissions");
const { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

// Ensure only a reasonable amount of instances run at once to manage billing safely
setGlobalOptions({ maxInstances: 10,  enforceAppCheck: true, memory: "512MiB" });

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
        batch.update(userRef, { reputation: admin.firestore.FieldValue.increment(value) });

        // 2. Update associated post reputation (if post_id exists)
        if (post_id) {
            const postRef = db.collection("posts").doc(post_id);
            batch.update(postRef, { reputation: admin.firestore.FieldValue.increment(value) });
        }

        // 3. Create notification
        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
            recipient_uid: target_id,
            type: "reputation_change",
            read: false,
            archived: false,
            payload: {
                voter_nickname: log.voter_nickname || "User",
                value: value,
                topic_id: log.topic_id || null,
                post_id: log.post_id || null,
                comment: log.comment || ""
            },
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();
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

      const priorPostsQuery = db.collection('posts')
        .where('topic_id', '==', topicId)
        .where('created_at', '<', createdAt);

      const countSnap = await priorPostsQuery.count().get();
      const countBefore = countSnap.data().count;
      const page = Math.floor(countBefore / itemsPerPage) + 1;

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
      
      const unreadPage = Math.floor(countBefore / itemsPerPage) + 1;
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

    return { pinned: pinnedTopics, topics, totalCount, hasMore: totalCount > startIndex + pageSize };
  }
);

/**
 * onTopicCreated
 * Increments topics_count for category and author.
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

        await batch.commit();
    } catch (error) {
        logger.error(`onTopicCreated error (${event.params.topicId}):`, error);
    }
});

/**
 * onTopicDeleted
 * Decrements topics_count. Rollback category posts_count using stored topic count.
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
        // queueIncrement returns false if the doc is missing, so we reuse
        // that signal to also skip the posts_count decrement.
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

        await batch.commit();

        // 2b. Cascade-delete posts. onPostDeleted skips topic/category counters
        //     once the topic is gone, so the -posts_count above stays correct —
        //     but only because the topic is deleted FIRST. Do not delete posts
        //     from the client.
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

        logger.info(`onTopicDeleted cleanup for ${event.params.topicId} successful.`);
    } catch (error) {
        logger.error(`onTopicDeleted error (${event.params.topicId}):`, error);
    }
});

/**
 * onPostCreated
 * Handles posts_count increments across topic, category, and user.
 * Syncs last_post metadata to topic and category.
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
        
        const newPostCount = currentTopicPostCount + 1;
        const shouldLock = newPostCount >= maxPostsPerTopic;

        const timestamp = created_at || admin.firestore.FieldValue.serverTimestamp();

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
                    last_post_is_character: !!is_character,
                    last_post_author_character_id: author_character_id || null
                });
            }
        }

        // 3. Update User (if not guest) — guard: user may have been deleted
        if (author_id) {
            await queueIncrement(batch, db.collection("users").doc(author_id), "post_count", 1);
        }

        await batch.commit();

        // 4. Notifications (Background)
        // We do this AFTER the main counters are committed for speed
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
 * Syncs metadata to topic and category if the last post was updated.
 */
exports.onPostUpdated = onDocumentUpdated("posts/{postId}", async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Check if author metadata changed
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
 * Logic migrated from client-side forum.js
 */
async function handlePostNotifications(db, { postId, topicId, authorId, topicTitle, content }) {
    try {
        // 1. Topic Reply Notifications
        const subSnap = await db.collection("topic_subscriptions").where("topic_id", "==", topicId).get();
        const subscribers = subSnap.docs.map(d => d.data().user_id).filter(uid => uid !== authorId);

        if (subscribers.length > 0) {

            // The transaction query below needs this composite index:
            // notifications: recipient_uid ASC, type ASC, payload.topic_id ASC, read ASC, archived ASC
            // Without it EVERY reply notification fails, and the catch at the bottom
            // hides it — verify in firestore.indexes.json.
            const CHUNK = 10;
            for (let i = 0; i < subscribers.length; i += CHUNK) {
              await Promise.all(subscribers.slice(i, i + CHUNK).map(recipientUid =>
                db.runTransaction(async (transaction) => {
                  // Check for existing unread topic_reply notification
                  const q = db.collection("notifications")
                      .where("recipient_uid", "==", recipientUid)
                      .where("type", "==", "topic_reply")
                      .where("payload.topic_id", "==", topicId)
                      .where("read", "==", false)
                      .where("archived", "==", false)
                      .limit(1);
                  
                  const existingSnap = await transaction.get(q);

                  if (!existingSnap.empty) {
                      const existingDoc = existingSnap.docs[0];
                      transaction.update(existingDoc.ref, {
                          "payload.post_count": admin.firestore.FieldValue.increment(1),
                          "payload.last_post_id": postId,
                          created_at: admin.firestore.FieldValue.serverTimestamp()
                      });
                  } else {
                      transaction.set(db.collection("notifications").doc(), {
                          recipient_uid: recipientUid,
                          type: "topic_reply",
                          read: false,
                          archived: false,
                          payload: {
                              topic_id: topicId,
                              topic_title: topicTitle,
                              first_post_id: postId,
                              last_post_id: postId,
                              post_count: 1
                          },
                          created_at: admin.firestore.FieldValue.serverTimestamp()
                      });
                  }
                })
            ));
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
                        await db.collection("notifications").add({
                            recipient_uid: qAuthorId,
                            type: "post_quoted",
                            read: false,
                            archived: false,
                            payload: {
                                topic_id: topicId,
                                topic_title: topicTitle,
                                post_id: postId
                            },
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
                        // Avoid duplicates if multiple mentions of same user
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
                                payload: {
                                    topic_id: topicId,
                                    topic_title: topicTitle,
                                    post_id: postId
                                },
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
 * onPostDeleted
 * Decrements posts_count and REVERTS reputation.
 */
exports.onPostDeleted = onDocumentDeleted("posts/{postId}", async (event) => {
    const snap = event.data;
    if (!snap) return;
    const post = snap.data();
    const { topic_id, author_id } = post;

    try {
        const db = admin.firestore();
        const batch = db.batch();

        // 1. Counters Fallback
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

        // 2. Revert Reputation Logs
        //    Do NOT revert reputation here — onReputationLogDeleted owns that.
        //    Doing both decremented the author twice whenever the batch did not
        //    fail outright on the already-deleted post document.
        const logsSnap = await db.collection("reputation_logs").where("post_id", "==", event.params.postId).get();
        logsSnap.forEach(l => batch.delete(l.ref));

        await batch.commit();

        // 3. Notification Cleanup
        const notifSnap = await db.collection("notifications")
            .where("payload.topic_id", "==", topic_id)
            .where("read", "==", false)
            .get();
        
        if (!notifSnap.empty) {
            const batchNotif = db.batch();
            notifSnap.forEach(d => {
                const data = d.data();
                if (data.type === 'topic_reply') {
                    const count = (data.payload?.post_count || 1) - 1;
                    if (count <= 0) {
                        batchNotif.delete(d.ref);
                    } else {
                        batchNotif.update(d.ref, { "payload.post_count": count });
                    }
                }
            });
            await batchNotif.commit();
        }

        // Cleanup direct post references (quotes, etc)
        const postNotifsSnap = await db.collection("notifications")
            .where("payload.post_id", "==", event.params.postId)
            .get();
        if (!postNotifsSnap.empty) {
            const batchPost = db.batch();
            postNotifsSnap.forEach(d => batchPost.delete(d.ref));
            await batchPost.commit();
        }

        // 4. Metadata Sync (Fallback) — pointless when the whole topic is going away.
        if (topicSnap.exists) {
            await syncTopicMetadata(db, topic_id);
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
        await catRef.update({
            last_post_at: lt.last_post_at || null,
            last_post_author: lt.last_post_author || null,
            last_post_author_id: lt.last_post_author_id || null,
            last_post_author_avatar: lt.last_post_author_avatar || null,
            last_post_topic_id: ltId,
            last_post_topic_title: lt.title,
            last_post_is_character: lt.last_post_is_character || false,
            last_post_author_character_id: lt.last_post_author_character_id || null
        });
    } else {
        await catRef.update({
            last_post_at: null,
            last_post_author: null,
            last_post_author_id: null,
            last_post_topic_id: null,
            last_post_topic_title: null
        });
    }
}

exports.onUserDeleted = onDocumentDeleted("users/{userId}", async (event) => {
    const deletedUid = event.params.userId;
    try {
        await admin.auth().deleteUser(deletedUid);
        logger.info(`Successfully deleted auth user: ${deletedUid}`);
    } catch (error) {
        logger.error(`Error deleting auth user ${deletedUid}:`, error);
    }
});

/**
 * onUserCreated
 * Triggers when a new user document is created.
 * Notifies all admins and user managers about the registration.
 */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
    const snap = event.data;
    if (!snap) return;
    const newUser = snap.data();
    const db = admin.firestore();

    try {
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

        // 2. Collect recipients (chunked: 'in' takes at most 30 values,
        //    the old slice(0, 30) silently dropped everything past the 30th role)
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
    const repShowComments = targetUserData.settings?.rep_show_comments;
    const shouldHideComments =
      repShowComments === false &&
      !isTargetUser &&
      !isRequesterAdmin &&
      !isRequesterModerator;

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
 */
exports.getSecuredPosts = onCall(
  { enforceAppCheck: false, minInstances: 0 },
  async (request) => {
    const { topicId, page = 1, pageSize = 20 } = request.data;
    if (!topicId) {
      throw new HttpsError('invalid-argument', 'Missing topicId');
    }

    // 1. Fetch the topic to get category_id
    const db = admin.firestore();
    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) {
      throw new HttpsError('not-found', 'Topic not found');
    }
    const topicData = topicDoc.data();
    const categoryId = topicData.category_id;

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

    // 3. Shared view_forum check — same rule as every other callable
    if (!hasViewForum(requesterRole, categoryId, ctx)) {
      throw new HttpsError('permission-denied', 'You do not have permission to view posts in this category.');
    }

    const startIndex = (page - 1) * pageSize;
    const postsSnap = await db.collection('posts')
      .where('topic_id', '==', topicId)
      .orderBy('created_at', 'asc')
      .offset(startIndex)
      .limit(pageSize)
      .get();

    // Pass 1: Collect raw posts and scan for UIDs in [hide] tags
    const rawPosts = [];
    const addresseeUids = new Set();
    const uidScanRegex = /\[hide=@([^\]\s]+)/gi;

    postsSnap.forEach(doc => {
      const data = doc.data();
      data.id = doc.id;
      rawPosts.push(data);

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
      if (data.created_at) data.created_at = data.created_at.toDate().toISOString();
      if (data.updated_at) data.updated_at = data.updated_at.toDate().toISOString();
      if (data.edited_at) data.edited_at = data.edited_at.toDate().toISOString();

      if (data.rolls) {
        Object.keys(data.rolls).forEach(rId => {
          const roll = data.rolls[rId];
          if (roll.type === 'master' && !canViewMasterDice && data.author_id !== uid) {
            roll.value = null; 
          }
        });
      }

      if (data.content && typeof data.content === 'string') {
        const isAuthor = data.author_id === uid;
        if (!canBypassHideTags && !isAuthor) {
          data.content = data.content.replace(/\[hide(?:=([^\]]+))?\]([\s\S]*?)\[\/hide\]/gi, (match, param) => {
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

      posts.push(data);
    }

    return { posts };
  }
);

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

    return {
      posts: visiblePosts,
      totalCount,
      hasMore: totalCount > startIndex + pageSize
    };
  }
);
