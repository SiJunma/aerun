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

// ONE request for the whole page.
//
// This was the heaviest read in the app: the handler answered with bare
// `topic_id`s, and this function then issued one `GET /api/aerun/topics/:id` per
// subscription in a fan-out. Thirty subscriptions meant thirty-one requests to
// draw one screen, on every visit.
//
// The handler now embeds each topic in the subscription row it already returns,
// so the normal path is a single round trip. The per-id read remains as a
// FALLBACK, not the default: it is what keeps this page working against a server
// that has not shipped the embedded payload yet, which is the only situation in
// which paying for it is justified.
const fetchTopicById = async (topicId) => {
  const t = await sendApi(`/api/aerun/topics/${topicId}`);
  return normalizeTopic(t?.topic);
};

export const fetchUserSubscribedTopics = async (userId, page = 1, pageSize = 20) => {
  if (!userId) return { topics: [], total: 0 };
  try {
    const res = await sendApi(`/api/aerun/me/subscriptions?page=${page}&limit=${pageSize}`);
    const items = res?.items || [];

    // NORMALISE BEFORE HANDING A ROW TO A RENDERER — same rule as every other
    // topic list, and the reason this page rendered "—".
    const embedded = items.filter((item) => item?.topic).map((item) => normalizeTopic(item.topic));

    // Only the rows the server did not embed pay for a request. A subscription
    // whose topic was deleted or has become unreadable arrives WITHOUT a topic
    // and is dropped here rather than costing a 404 to discover.
    const embeddedIds = new Set(embedded.map((topic) => topic.id));
    const missingIds = items
      .map((item) => item?.topic_id)
      .filter((id) => id && !embeddedIds.has(id));

    const fetched = missingIds.length > 0
      ? await Promise.all(missingIds.map(async (id) => {
        try {
          return await fetchTopicById(id);
        } catch {
          return null;
        }
      }))
      : [];

    const validTopics = [...embedded, ...fetched].filter(Boolean);
    // Порядок задаёт сервер (ORDER BY topics.last_post_created DESC, id DESC
    // в listUserSubscriptionsHandler). Клиентская пересортировка только внутри
    // страницы ломала межстраничный порядок — убрана. Один источник порядка.
    // `total` is the server's count over the WHOLE list, not this page — it is
    // what the pager divides by, exactly as on a category page.
    //
    // It CAN exceed this page's row count even here: the server counts
    // subscriptions, while rows whose topic is deleted or no longer readable are
    // dropped below. Reporting the dropped count instead would make the pager
    // disagree with itself — pages that exist but render empty.
    return { topics: validTopics, total: res?.total ?? validTopics.length };
  } catch (err) {
    console.warn('[fetchUserSubscribedTopics]', err);
    // Rethrown, not swallowed into an empty list. This function used to answer
    // [] for a failed read, which is indistinguishable from "you subscribe to
    // nothing" — so a dropped connection rendered an empty page and a member
    // concluded their subscriptions were gone. The page catches this and shows
    // its own error state.
    throw err;
  }
};
