import { sendApi, pb } from './pocketbase';

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
          return t?.topic || null;
        } catch {
          return null;
        }
      })
    );

    const validTopics = topics.filter(Boolean);
    validTopics.sort((a, b) => {
      const aTime = a.last_post_at ? new Date(a.last_post_at).getTime() : (a.created_at ? new Date(a.created_at).getTime() : 0);
      const bTime = b.last_post_at ? new Date(b.last_post_at).getTime() : (b.created_at ? new Date(b.created_at).getTime() : 0);
      return bTime - aTime;
    });

    return validTopics;
  } catch (err) {
    console.warn('[fetchUserSubscribedTopics]', err);
    return [];
  }
};
