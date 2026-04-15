const { onDocumentCreated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

// Ensure only a reasonable amount of instances run at once to manage billing safely
setGlobalOptions({ maxInstances: 10 });

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
 */
exports.onReputationLogDeleted = onDocumentDeleted("reputation_logs/{logId}", async (event) => {
    const snap = event.data;
    if (!snap) return;

    const log = snap.data();
    const { target_id, post_id, value } = log;

    if (!target_id || typeof value !== 'number') return;

    try {
        const db = admin.firestore();
        const batch = db.batch();

        // 1. Revert target user reputation
        const userRef = db.collection("users").doc(target_id);
        batch.update(userRef, { reputation: admin.firestore.FieldValue.increment(-value) });

        // 2. Revert associated post reputation
        if (post_id) {
            const postRef = db.collection("posts").doc(post_id);
            batch.update(postRef, { reputation: admin.firestore.FieldValue.increment(-value) });
        }

        await batch.commit();
        logger.info(`Reputation reverted for deleted log ${snap.id}: target=${target_id}, value=${-value}`);
    } catch (error) {
        logger.error(`Error reverting reputation for log ${snap.id}:`, error);
    }
});

/**
 * onTopicCreated
 * Increments topics_count for category and author.
 */
exports.onTopicCreated = onDocumentCreated("topics/{topicId}", async (event) => {
    const snap = event.data;
    if (!snap) return;
    const topic = snap.data();
    const { category_id, author_id } = topic;

    try {
        const db = admin.firestore();
        const batch = db.batch();

        // 1. Category topics_count
        const catRef = db.collection("categories").doc(category_id);
        batch.update(catRef, { topics_count: admin.firestore.FieldValue.increment(1) });

        // 2. User topics_count (if not guest)
        if (author_id) {
            const userRef = db.collection("users").doc(author_id);
            batch.update(userRef, { topics_count: admin.firestore.FieldValue.increment(1) });
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

        const catRef = db.collection("categories").doc(category_id);
        batch.update(catRef, {
            topics_count: admin.firestore.FieldValue.increment(-1),
            posts_count: admin.firestore.FieldValue.increment(-posts_count)
        });

        if (author_id) {
            const userRef = db.collection("users").doc(author_id);
            batch.update(userRef, { topics_count: admin.firestore.FieldValue.increment(-1) });
        }

        await batch.commit();

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
        const topicSnap = await topicRef.get();
        if (!topicSnap.exists) return;
        const topicData = topicSnap.data();
        const { category_id, title: topic_title } = topicData;

        const timestamp = created_at || admin.firestore.FieldValue.serverTimestamp();

        // 1. Update Topic
        batch.update(topicRef, {
            posts_count: admin.firestore.FieldValue.increment(1),
            last_post_at: timestamp,
            last_post_author: author_name,
            last_post_author_id: author_id || null,
            last_post_author_avatar: author_avatar || null,
            last_post_is_character: !!is_character,
            last_post_author_character_id: author_character_id || null
        });

        // 2. Update Category
        const catRef = db.collection("categories").doc(category_id);
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

        // 3. Update User (if not guest)
        if (author_id) {
            const userRef = db.collection("users").doc(author_id);
            batch.update(userRef, { post_count: admin.firestore.FieldValue.increment(1) });
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
 * handlePostNotifications
 * Logic migrated from client-side forum.js
 */
async function handlePostNotifications(db, { postId, topicId, authorId, topicTitle, content }) {
    try {
        // 1. Topic Reply Notifications
        const subSnap = await db.collection("topic_subscriptions").where("topic_id", "==", topicId).get();
        const subscribers = subSnap.docs.map(d => d.data().user_id).filter(uid => uid !== authorId);

        if (subscribers.length > 0) {
            for (const recipientUid of subscribers) {
                await db.runTransaction(async (transaction) => {
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
                });
            }
        }

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
        const logsSnap = await db.collection("reputation_logs").where("post_id", "==", event.params.postId).get();
        if (!logsSnap.empty) {
            let totalVal = 0;
            logsSnap.forEach(l => {
                const val = l.data().value || 0;
                totalVal += val;
                batch.delete(l.ref);
            });
            if (author_id) {
                const userRef = db.collection("users").doc(author_id);
                batch.update(userRef, { reputation: admin.firestore.FieldValue.increment(-totalVal) });
            }
        }

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

        // 4. Metadata Sync (Fallback)
        await syncTopicMetadata(db, topic_id);

        
        logger.info(`onPostDeleted cleanup for ${event.params.postId} successful.`);
    } catch (error) {
        logger.error(`onPostDeleted error (${event.params.postId}):`, error);
    }
});

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
        const USER_MGMT_PERMS = ["APPROVE_USERS", "BAN_USERS", "DELETE_USERS"];

        rolesSnap.forEach(doc => {
            const data = doc.data();
            const perms = data.permissions || [];
            if (USER_MGMT_PERMS.some(p => perms.includes(p))) {
                eligibleRoleIds.push(doc.id);
            }
        });

        // 2. Collect recipients
        const recipients = new Set();
        
        // managers
        if (eligibleRoleIds.length > 0) {
            const usersSnap = await db.collection("users")
                .where("role_id", "in", eligibleRoleIds.slice(0, 30))
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
        logger.info(`onUserCreated: Notified ${recipients.size} managers for user ${event.params.uid}`);
    } catch (error) {
        logger.error(`onUserCreated error (${event.params.uid}):`, error);
    }
});