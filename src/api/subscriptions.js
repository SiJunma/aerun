import { sendApi, pb } from './pocketbase';
// normalizeTopic is imported, not re-implemented: /subscriptions renders the very
// same TopicRow as the category page, and TopicRow reads the NORMALISED names
// (`created_at`, `last_post_at`, `is_pinned`). The raw `GET /topics/:id` payload
// spells the same facts `created`, `last_post_created` and `pinned`
// (topicPayload in forum_topics.go), so every row here rendered a literal "—"
// for both timestamps and lost its pin icon, while the identical topic under
// /category/<id> rendered fine. Rows also sorted by `last_post_at`/`created_at`
// on a payload that has neither, so "newest activity first" was a no-op.
import { normalizeTopic } from './forum';

export const subscribeToTopicStatus = (topicId, userId, callback) => {
  if (!topicId || !userId) {
    callback(false);
    return () => {};
  }

  let isSubscribed = true;
  sendApi(`/api/aerun/topics/${topicId}/subscription`)
    .then(data => {
      if (isSubscribed) {
        callback(!!data?.subscribed);
      }
    })
    .catch(err => {
      console.warn('[subscribeToTopicStatus]', err);
      if (isSubscribed) callback(false);
    });

  return () => {
    isSubscribed = false;
  };
};

export const toggleSubscription = async (topicId, userId) => {
  if (!topicId || !userId) return false;

  const current = await sendApi(`/api/aerun/topics/${topicId}/subscription`);
  if (current?.subscribed) {
    const res = await sendApi(`/api/aerun/topics/${topicId}/unsubscribe`, { method: 'POST' });
    return !!res?.subscribed;
  } else {
    const res = await sendApi(`/api/aerun/topics/${topicId}/subscribe`, { method: 'POST' });
    return !!res?.subscribed;
  }
};

export const getTopicSubscribers = async (topicId) => {
  if (!topicId) return [];
  try {
    const list = await pb.collection('topic_subscriptions').getFullList({
      filter: `topic_id = "${topicId}"`,
      fields: 'user_id'
    });
    return list.map(r => r.user_id);
  } catch (err) {
    console.warn('[getTopicSubscribers]', err);
    return [];
  }
};

export const fetchUserSubscribedTopics = async (userId) => {
  if (!userId) return [];
  try {
    const res = await sendApi('/api/aerun/me/subscriptions?limit=100');
    const items = res?.items || [];
    const topicIds = items.map(item => item.topic_id).filter(Boolean);
    if (topicIds.length === 0) return [];

    const topics = await Promise.all(
      topicIds.map(async (id) => {
        try {
          const t = await sendApi(`/api/aerun/topics/${id}`);
          // NORMALISE BEFORE HANDING A ROW TO A RENDERER — same rule as every
          // other topic list, and the reason this page rendered "—".
          return normalizeTopic(t?.topic);
        } catch {
          return null;
        }
      })
    );

    const validTopics = topics.filter(Boolean);
    // `last_post_at_ms` is what normalizeTopic derived, so a topic whose last
    // post is the opening one still sorts by its real activity instead of by
    // an undefined field.
    validTopics.sort((a, b) => (b.last_post_at_ms || 0) - (a.last_post_at_ms || 0));

    return validTopics;
  } catch (err) {
    console.warn('[fetchUserSubscribedTopics]', err);
    return [];
  }
};
