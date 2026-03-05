import { db } from '../../firebase';
import { 
  collection, 
  addDoc, 
  doc, 
  onSnapshot, 
  query, 
  orderBy, 
  where,
  serverTimestamp,
  runTransaction,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';

// Fetch all categories
export const subscribeToCategories = (callback) => {
  const q = query(collection(db, 'categories'), orderBy('order', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

export const addCategory = async (catData) => {
  await addDoc(collection(db, 'categories'), {
    ...catData,
    topics_count: 0,
    posts_count: 0,
    created_at: serverTimestamp()
  });
};

export const updateCategory = async (id, catData) => {
  const docRef = doc(db, 'categories', id);
  await updateDoc(docRef, {
    ...catData,
    updated_at: serverTimestamp()
  });
};

export const deleteCategory = async (id) => {
  const docRef = doc(db, 'categories', id);
  await deleteDoc(docRef);
};

// Fetch topics for a category
export const subscribeToTopics = (categoryId, callback) => {
  const q = query(
    collection(db, 'topics'), 
    where('category_id', '==', categoryId),
    orderBy('last_post_at', 'desc')
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

// Fetch posts for a topic
export const subscribeToPosts = (topicId, callback) => {
  const q = query(
    collection(db, 'posts'), 
    where('topic_id', '==', topicId),
    orderBy('created_at', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

// Create a new topic (via transaction to create first post and update category stats)
export const createTopic = async (topicData, firstPostData) => {
  await runTransaction(db, async (transaction) => {
    const topicRef = doc(collection(db, 'topics'));
    const postRef = doc(collection(db, 'posts'));
    const categoryRef = doc(db, 'categories', topicData.category_id);

    const timestamp = serverTimestamp();

    transaction.set(topicRef, {
      ...topicData,
      last_post_at: timestamp,
      created_at: timestamp,
      posts_count: 1
    });

    transaction.set(postRef, {
      ...firstPostData,
      topic_id: topicRef.id,
      created_at: timestamp
    });

    // We skip updating category stats here for simplicity in this MVP, 
    // but usually you want to increment topics_count here.
  });
};

// Reply to a topic
export const createPost = async (postData) => {
  await runTransaction(db, async (transaction) => {
    const postRef = doc(collection(db, 'posts'));
    const topicRef = doc(db, 'topics', postData.topic_id);
    const timestamp = serverTimestamp();

    transaction.set(postRef, {
      ...postData,
      created_at: timestamp
    });

    transaction.update(topicRef, {
      last_post_at: timestamp,
      last_post_author: postData.author_name,
      posts_count: serverTimestamp() // In production use increment(1)
    });
  });
};
