import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Breadcrumb, Button, Form, Modal, Pagination, Toast, ToastContainer } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToPosts, createPost, updatePost, deletePost, subscribeToTopic, subscribeToCategories, subscribeToUser, updateUser, updateTopic } from '../api/forum';
import { subscribeToCharacters } from '../api/character';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumModal from '../components/common/ForumModal';
import RichEditor from '../components/common/RichEditor';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import BBCode from '../components/common/BBCode';
import { Award } from 'lucide-react';
import { voteOnPost, getVotesInTopic } from '../api/reputation';
import ForumPagination from '../components/common/ForumPagination';
import ForumAuthorName from '../components/common/ForumAuthorName';

const AvatarImage = ({ src, fallbackName, size = 90 }) => {
  const [error, setError] = useState(false);
  const finalSrc = error || !src
    ? `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName || '?')}&background=random`
    : src;

  return (
    <Image
      src={finalSrc}
      rounded
      fluid
      className="mb-2 shadow-sm"
      style={{ width: `${size}px`, height: `${size}px`, objectFit: 'cover' }}
      referrerPolicy="no-referrer"
      onError={(e) => {
        if (!error) {
          setError(true);
        } else {
          // If even the fallback fails, remove the onError handler to stop the loop
          e.target.onerror = null;
          // As a last-resort fallback, use a hardcoded generic avatar that is guaranteed to load 
          // (or just a blank data URI to prevent broken image icons)
          e.target.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90" viewBox="0 0 90 90"><rect width="90" height="90" fill="%23ccc"/><text x="45" y="45" font-family="Arial" font-size="30" fill="%23fff" text-anchor="middle" dy=".3em">?</text></svg>';
        }
      }}
    />
  );
};

const TopicPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const { profile, user, recordActivity } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [replyContent, setReplyContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [topic, setTopic] = useState(null);
  const [category, setCategory] = useState(null);
  const [posts, setPosts] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [authorStats, setAuthorStats] = useState({}); // { uid: { post_count: N } }

  // Edit state
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState('');
  // Extra fields when editing the first post (topic title/description)
  const [editTopicTitle, setEditTopicTitle] = useState('');
  const [editTopicDescription, setEditTopicDescription] = useState('');
  const [editingFirstPost, setEditingFirstPost] = useState(false);

  // Delete confirmation state
  const [deletingPost, setDeletingPost] = useState(null);

  // Reputation state
  const [myVotes, setMyVotes] = useState({}); // { postId: value }
  const [votingPostId, setVotingPostId] = useState(null);
  const [showRepModal, setShowRepModal] = useState(false);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [submittingRep, setSubmittingRep] = useState(false);
  const [repTargetPost, setRepTargetPost] = useState(null);
  const [repTargetPostNumber, setRepTargetPostNumber] = useState(null);
  const [activeRepPostId, setActiveRepPostId] = useState(null);
  const [showVoteInfoModal, setShowVoteInfoModal] = useState(false);
  const [selectedVote, setSelectedVote] = useState(null);

  const replyRef = useRef(null);
  const scrolledRef = useRef(false); // prevent double-scroll
  const goLast = searchParams.get('goLast') === '1';
  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);
  const MAX_CHARS = 15000;
  const LAST_VISIT_KEY = `lastVisit_${id}`;

  useEffect(() => {
    const unsubPosts = subscribeToPosts(id, setPosts);
    const unsubTopic = subscribeToTopic(id, setTopic);

    // Save last visit timestamp when leaving this topic
    const visitTime = Date.now();
    return () => {
      localStorage.setItem(LAST_VISIT_KEY, visitTime.toString());
      unsubPosts();
      unsubTopic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Subscribe to characters separately so we can unsubscribe properly
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToCharacters(user.uid, setCharacters);

    // Fetch my votes in this topic
    getVotesInTopic(user.uid, id).then(setMyVotes).catch(console.error);

    return () => unsub();
  }, [user, id]);

  // Set initial selectedCharacterId from profile
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.last_selected_character_id]);

  useEffect(() => {
    if (topic?.category_id) {
      const unsubCat = subscribeToCategories((cats) => {
        const found = cats.find(c => c.id === topic.category_id);
        if (found) setCategory(found);
      });
      return () => unsubCat();
    }
  }, [topic?.category_id]);

  // Draft Auto-save
  const DRAFT_KEY = `reply_draft_${id}`;

  useEffect(() => {
    const savedDraft = localStorage.getItem(DRAFT_KEY);
    if (savedDraft) {
      setReplyContent(savedDraft);
    }
  }, [id, DRAFT_KEY]);

  useEffect(() => {
    if (replyContent) {
      localStorage.setItem(DRAFT_KEY, replyContent);
    } else {
      localStorage.removeItem(DRAFT_KEY);
    }
  }, [replyContent, DRAFT_KEY]);

  // Subscribe to author stats for each unique author in posts
  useEffect(() => {
    if (posts.length === 0) return;
    const uniqueAuthorIds = [...new Set(posts.map(p => p.author_id))];
    const unsubs = uniqueAuthorIds.map(uid => {
      return subscribeToUser(uid, (data) => {
        if (data) {
          setAuthorStats(prev => ({ ...prev, [uid]: data }));
        }
      });
    });
    return () => unsubs.forEach(unsub => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length > 0 ? [...new Set(posts.map(p => p.author_id))].join(',') : '']);

  // Toast notification
  const [toast, setToast] = useState({ show: false, message: '', variant: 'success' });
  const showToast = (message, variant = 'success') => {
    setToast({ show: true, message, variant });
  };

  // Scroll to first unread post (or last post if ?goLast=1, or specific post if #post-ID)
  useEffect(() => {
    if (posts.length === 0 || scrolledRef.current) return;

    let targetId;
    let targetPage = currentPage;
    const hash = window.location.hash;

    if (hash && hash.startsWith('#post-')) {
      const postId = hash.replace('#post-', '');
      const postIndex = posts.findIndex(p => p.id === postId);
      if (postIndex !== -1) {
        targetPage = Math.ceil((postIndex + 1) / ITEMS_PER_PAGE);
        if (currentPage !== targetPage) {
          setSearchParams({ page: targetPage });
          return;
        }
        targetId = hash.substring(1); // remove #
      }
    } else if (goLast) {
      targetPage = Math.ceil(posts.length / ITEMS_PER_PAGE) || 1;
      if (currentPage !== targetPage) {
        setSearchParams({ page: targetPage, goLast: '1' });
        return;
      }
      targetId = `post-${posts[posts.length - 1].id}`;
    } else {
      const lastVisit = parseInt(localStorage.getItem(LAST_VISIT_KEY) || '0', 10);
      const unreadIndex = posts.findIndex(p => {
        const ms = p.created_at?.toMillis?.() ?? 0;
        return ms > lastVisit;
      });

      if (unreadIndex !== -1) {
        targetPage = Math.ceil((unreadIndex + 1) / ITEMS_PER_PAGE);
        if (currentPage !== targetPage) {
          setSearchParams({ page: targetPage });
          return;
        }
        targetId = `post-${posts[unreadIndex].id}`;
      }
    }

    if (targetId) {
      scrolledRef.current = true;
      setTimeout(() => {
        const el = document.getElementById(targetId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length, goLast, currentPage]); const formatTime = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const getLiveOwnerName = (post) => {
    if (post.author_id === user?.uid) {
      return profile?.nickname || post.owner_name;
    }
    return authorStats[post.author_id]?.nickname || post.owner_name;
  };

  const getLiveAuthorAvatar = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char?.avatar_url || post.author_avatar;
      }
      return profile?.avatar_url || post.author_avatar;
    }
    return authorStats[post.author_id]?.avatar_url || post.author_avatar;
  };

  const getLiveAuthorStatus = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.status_line || '') : (post.author_status_line || '');
      }
      return profile ? (profile.status_line || '') : (post.author_status_line || '');
    }
    const stats = authorStats[post.author_id];
    return (stats && stats.nickname) ? (stats.status_line || '') : (post.author_status_line || '');
  };

  const getLiveAuthorSignature = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.signature || '') : (post.author_signature || '');
      }
      return profile?.settings?.signature || post.author_signature || '';
    }
    const stats = authorStats[post.author_id];
    return (stats && stats.nickname) ? (stats.settings?.signature || '') : (post.author_signature || '');
  };

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';


  const handleOpenVoteModal = (post, value, postNumber) => {
    if (!user || profile?.role_id === 'spectator') return;
    if (post.author_id === user.uid) return;
    if (myVotes[post.id]) return;

    setRepTargetPost(post);
    setRepValue(value);
    setRepTargetPostNumber(postNumber);
    setRepComment('');
    setShowRepModal(true);
  };

  const handleRepVote = async () => {
    if (!repTargetPost || !user) return;
    setSubmittingRep(true);
    try {
      await voteOnPost(user.uid, repTargetPost.author_id, repTargetPost.id, id, repValue, repComment, topic?.title, repTargetPostNumber);
      setShowRepModal(false); // Close AFTER success
      setMyVotes(prev => ({
        ...prev,
        [repTargetPost.id]: {
          value: repValue,
          comment: repComment,
          voter_nickname: profile?.nickname || user.displayName || 'User',
          topic_title: topic?.title || '',
          post_number: repTargetPostNumber,
          created_at: { toDate: () => new Date() }
        }
      }));
      recordActivity();
      showToast(lang === 'ru' ? 'Репутация изменена!' : 'Reputation updated!');
    } catch (error) {
      console.error('Voting error:', error);
      showToast(error.message, 'danger');
    } finally {
      setSubmittingRep(false);
      setRepTargetPost(null);
      setRepTargetPostNumber(null);
    }
  };

  const handleReply = async (e) => {
    e.preventDefault();
    if (!replyContent.trim() || submitting) return;

    recordActivity(); // posting = user is active
    setSubmitting(true);
    try {
      const selectedChar = characters.find(c => c.id === selectedCharacterId);

      const postData = {
        topic_id: id,
        content: replyContent.trim(),
        author_id: user.uid,
        author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'),
        author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || user?.photoURL || ''),
        author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
        author_role_id: profile?.role_id || 'player',
        is_character: !!selectedChar,
        author_character_id: selectedCharacterId || null,
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
        owner_name: profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'
      };

      const newPostId = await createPost(postData);
      // Mark as read immediately
      localStorage.setItem(LAST_VISIT_KEY, Date.now().toString());
      setReplyContent('');
      
      // Calculate where the new post will be (it's always the last one)
      const newTotalPosts = posts.length + 1;
      const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE);
      
      if (targetPage !== currentPage) {
        setSearchParams({ page: targetPage });
      }

      // We need to wait for the DOM to update. Since setPosts is triggered by a Firestore subscription,
      // it might take a moment. We'll use a small timeout or wait for the posts to update.
      setTimeout(() => {
        const element = document.getElementById(`post-${newPostId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('highlight-new-post');
          setTimeout(() => element.classList.remove('highlight-new-post'), 2000);
        }
      }, 500);

    } catch (err) {
      console.error(err);
      alert('Error posting reply');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartEdit = (post, isFirst = false) => {
    setEditingPostId(post.id);
    setEditContent(post.content);
    setEditingFirstPost(isFirst);
    if (isFirst && topic) {
      setEditTopicTitle(topic.title || '');
      setEditTopicDescription(topic.description || '');
    }
  };

  const handleSaveEdit = async (postId) => {
    if (!editContent.trim()) return;
    try {
      await updatePost(postId, editContent.trim(), {});
      if (editingFirstPost && topic) {
        await updateTopic(topic.id, {
          title: editTopicTitle.trim() || topic.title,
          description: editTopicDescription.trim()
        });
      }
      setEditingPostId(null);
      setEditContent('');
      setEditingFirstPost(false);
      setEditTopicTitle('');
      setEditTopicDescription('');
    } catch (err) {
      console.error(err);
      alert('Error editing post');
    }
  };

  const handleDeletePost = async () => {
    if (!deletingPost) return;
    const isOnlyPost = posts.length === 1;
    const categoryId = topic?.category_id;
    
    try {
      await deletePost(deletingPost);
      setDeletingPost(null);
      
      if (isOnlyPost) {
        // Topic was deleted because it was the last post
        if (categoryId) {
          navigate(`/category/${categoryId}`);
        } else {
          navigate('/');
        }
      }
    } catch (err) {
      console.error(err);
      alert('Error deleting post');
    }
  };

  const canManagePost = (post) => {
    if (!user) return false;
    return post.author_id === user.uid || profile?.role_id === 'admin' || profile?.role_id === 'moderator';
  };

  const getRoleBadge = (post) => {
    if (post.is_character) return null;
    const role = post.author_role_id;
    if (role === 'admin') return <Badge bg="danger" className="mb-2 opacity-90">Admin</Badge>;
    if (role === 'moderator') return <Badge bg="warning" text="dark" className="mb-2 opacity-90">Moderator</Badge>;
    return <Badge bg="secondary" className="mb-2 opacity-75">Member</Badge>;
  };

  if (!topic) {
    return (
      <Container className="py-5 text-center">
        <div className="spinner-border text-primary" role="status" />
      </Container>
    );
  }

  const categoryTitle = category ? resolveText(category.title) : '...';

  // Pagination logic
  const totalPages = Math.ceil(posts.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentPosts = posts.slice(indexOfFirstItem, indexOfLastItem);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0 });
  };

  return (
    <Container className="py-4">
      <Breadcrumb className="mb-4">
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/' }}>{t('nav.home')}</Breadcrumb.Item>
        {category && (
          <Breadcrumb.Item linkAs={Link} linkProps={{ to: `/category/${category.id}` }}>
            {categoryTitle}
          </Breadcrumb.Item>
        )}
        <Breadcrumb.Item active>{topic.title}</Breadcrumb.Item>
      </Breadcrumb>

      {/* Topic header */}
      <div className="mb-3">
        <h1 className="h2 mb-1">{topic.title}</h1>
        {topic.description && (
          <p className="text-muted mb-2">{topic.description}</p>
        )}
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div className="d-flex align-items-center gap-2 flex-wrap small text-muted">
            <span>
              {t('forum.author')}:{' '}
              <ForumAuthorName
                userId={topic.author_id}
                characterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                fallbackName={topic.author_name}
                className="fw-semibold text-primary"
              />
            </span>
            <span>·</span>
            <span>
              {lang === 'ru' ? 'Ответы' : 'Replies'}:{' '}
              <strong>{Math.max(0, (topic.posts_count || 1) - 1)}</strong>
            </span>
            <span>·</span>
            <span>
              {lang === 'ru' ? 'Просмотры' : 'Views'}:{' '}
              <strong>{topic.views || 0}</strong>
            </span>
            <span>·</span>
            <span>{formatTime(topic.created_at)}</span>
          </div>

          {totalPages > 1 && (
            <div className="ms-auto ms-sm-0">
              <ForumPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            </div>
          )}
        </div>
      </div>
      <div className="mb-3" /> {/* Reduced divider spacing */}

      {/* Posts */}
      <div className="posts-container">
        {currentPosts.map((post, index) => (
          <Card key={post.id} id={`post-${post.id}`} className="mb-4 shadow-sm border-0 post-card">
            <Card.Body className="p-0">
              <Row className="g-0">
                {/* Author sidebar */}
                <Col md={3} lg={2} className="author-sidebar border-end px-3 py-2 text-center d-flex flex-column align-items-center">
                  {/* 1. Nickname */}
                  <div className="fw-bold text-center mb-1 text-truncate" style={{ maxWidth: '100%' }}>
                    <ForumAuthorName
                      userId={post.author_id}
                      characterId={post.author_character_id}
                      isCharacter={!!post.is_character}
                      fallbackName={post.author_name}
                    />
                  </div>

                  {/* 2. Status */}
                  {getLiveAuthorStatus(post) && (
                    <div className="text-primary small mb-2 text-truncate w-100 px-2" style={{ fontStyle: 'italic', lineHeight: '1.2' }}>
                      {getLiveAuthorStatus(post)}
                    </div>
                  )}

                  {/* 3. Avatar */}
                  <AvatarImage
                    src={getLiveAuthorAvatar(post)}
                    fallbackName={post.author_name}
                  />

                  {/* 4. Posts Count */}
                  <div className="text-muted small mt-1">
                    {t('profile.posts_count')}: <strong>{authorStats[post.author_id]?.post_count || 0}</strong>
                  </div>

                  {/* 5. Reputation */}
                  <div className="text-muted small">
                    {t('profile.reputation')}: <strong>{authorStats[post.author_id]?.reputation || 0}</strong>
                  </div>

                  {/* 6. Role/Mask */}
                  {!post.is_character && (
                    <div className="mt-2 text-center w-100">{getRoleBadge(post)}</div>
                  )}
                  {post.is_character && (
                    <div className="text-muted mt-1 small opacity-75">
                      {lang === 'ru' ? 'персонаж' : 'character'}
                      {getLiveOwnerName(post) && ` (${getLiveOwnerName(post)})`}
                    </div>
                  )}
                </Col>

                {/* Content Area */}
                <Col md={9} lg={10} className="d-flex flex-column" style={{ minHeight: '100%' }}>
                  {/* Header Strip: Time, # */}
                  <div className="post-header-strip px-4 py-1 d-flex justify-content-between align-items-center">
                    <small className="text-muted">
                      <a
                        href={`#post-${post.id}`}
                        className="text-decoration-none text-muted hover-link"
                        onClick={(e) => {
                          e.preventDefault();
                          const url = `${window.location.origin}${window.location.pathname}${window.location.search}#post-${post.id}`;
                          navigator.clipboard.writeText(url);
                          showToast(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
                          // Also navigate for classic behavior
                          window.location.hash = `post-${post.id}`;
                        }}
                      >
                        {formatTime(post.created_at)}
                      </a>
                      {post.edited_at && (
                        <span className="ms-2 opacity-50">
                          ({lang === 'ru' ? 'ред.' : 'edited'} {formatTime(post.edited_at)})
                        </span>
                      )}
                    </small>
                    <div className="text-muted small opacity-50 fw-bold">#{index + indexOfFirstItem + 1}</div>
                  </div>

                  {/* Body Area */}
                  <div className="px-4 py-2 flex-grow-1 d-flex flex-column">
                    <div className="flex-grow-1">
                      {editingPostId === post.id ? (
                        <div>
                          {editingFirstPost && (
                            <div className="mb-3">
                              <Form.Group className="mb-2">
                                <Form.Label className="fw-semibold small">
                                  {lang === 'ru' ? 'Название темы' : 'Topic Title'}
                                </Form.Label>
                                <Form.Control
                                  type="text"
                                  value={editTopicTitle}
                                  onChange={e => setEditTopicTitle(e.target.value)}
                                  maxLength={100}
                                  required
                                />
                              </Form.Group>
                              <Form.Group>
                                <Form.Label className="fw-semibold small">
                                  {lang === 'ru' ? 'Описание темы' : 'Topic Description'}
                                </Form.Label>
                                <Form.Control
                                  type="text"
                                  value={editTopicDescription}
                                  onChange={e => setEditTopicDescription(e.target.value)}
                                  maxLength={200}
                                  placeholder={lang === 'ru' ? 'Краткое описание...' : 'Short description...'}
                                />
                              </Form.Group>
                            </div>
                          )}
                          <div className="mb-2">
                            <RichEditor
                              id="editContent"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              rows={6}
                              maxLength={MAX_CHARS}
                            />
                          </div>
                          <div className="d-flex gap-2">
                            <Button size="sm" variant="primary" onClick={() => handleSaveEdit(post.id)}>
                              {lang === 'ru' ? 'Сохранить' : 'Save'}
                            </Button>
                            <Button size="sm" variant="outline-secondary" onClick={() => setEditingPostId(null)}>
                              {lang === 'ru' ? 'Отмена' : 'Cancel'}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="post-content">
                          <BBCode>{post.content}</BBCode>
                        </div>
                      )}

                      {/* Signature */}
                      {getLiveAuthorSignature(post) && (
                        <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                          <BBCode>{getLiveAuthorSignature(post)}</BBCode>
                        </div>
                      )}
                    </div>

                    {/* Reputation / Voting Buttons */}
                    <div className="mt-3 d-flex justify-content-end align-items-center gap-3 reputation-section">
                      <div
                        className={`text-muted small d-flex align-items-center gap-1 ${post.author_id !== profile?.uid && profile?.role_id !== 'spectator' ? 'rep-trigger' : ''}`}
                        title={post.author_id !== profile?.uid && profile?.role_id !== 'spectator'
                          ? (lang === 'ru' ? 'Репутация сообщения (Нажмите чтобы проголосовать или посмотреть детали)' : 'Post Reputation (Click to vote or view details)')
                          : (lang === 'ru' ? 'Репутация сообщения' : 'Post Reputation')}
                        onClick={() => {
                          if (post.author_id === profile?.uid || profile?.role_id === 'spectator') return;

                          if (myVotes[post.id]) {
                            setSelectedVote(myVotes[post.id]);
                            setShowVoteInfoModal(true);
                          } else {
                            setActiveRepPostId(activeRepPostId === post.id ? null : post.id);
                          }
                        }}
                      >
                        <Award size={14} className="text-accent" />
                        <strong>{post.reputation || 0}</strong>
                        {myVotes[post.id] && (
                          <span className="ms-1" style={{ fontWeight: 400, opacity: 0.8 }}>
                            ({myVotes[post.id].value > 0 ? '+1' : '-1'})
                          </span>
                        )}
                      </div>

                      {activeRepPostId === post.id && !myVotes[post.id] && post.author_id !== profile?.uid && (
                        <div className="reputation-controls d-flex align-items-center rounded px-2 py-1 gap-2 animate-fade-in shadow-sm">
                          {profile?.role_id !== 'spectator' && (
                            <div className="d-flex gap-1">
                              <Button
                                size="sm"
                                variant="outline-danger"
                                className="py-0 px-2 voting-btn"
                                disabled={votingPostId === post.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenVoteModal(post, -1, index + indexOfFirstItem + 1);
                                }}
                              >
                                −
                              </Button>
                              <Button
                                size="sm"
                                variant="outline-success"
                                className="py-0 px-2 voting-btn"
                                disabled={votingPostId === post.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenVoteModal(post, 1, index + indexOfFirstItem + 1);
                                }}
                              >
                                +
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Col>
              </Row>

              {/* Classic Footer Strip (Combined) */}
              <div className="post-footer-strip">
                <Row className="g-0 align-items-center">
                  <Col md={3} lg={2} className="author-sidebar border-end px-3 py-2 d-flex gap-3 justify-content-center">
                    <Link to={`/profile/${post.author_id}`} className="footer-link text-decoration-none">
                      {t('profile.view_profile')}
                    </Link>
                    <Link to="#" className="footer-link text-decoration-none" onClick={(e) => e.preventDefault()}>
                      {t('profile.pm')}
                    </Link>
                  </Col>
                  <Col md={9} lg={10} className="px-4 py-2 d-flex justify-content-end gap-3">
                    {canManagePost(post) && (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          className="footer-link p-0"
                          onClick={() => setDeletingPost(post)}
                        >
                          {lang === 'ru' ? 'Удалить' : 'Delete'}
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          className="footer-link p-0"
                          onClick={() => handleStartEdit(post, (index + indexOfFirstItem) === 0)}
                        >
                          {lang === 'ru' ? 'Редактировать' : 'Edit'}
                        </Button>
                      </>
                    )}
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0"
                      onClick={() => {
                        const selectedText = window.getSelection().toString().trim();
                        const author = getLiveAuthorName(post);
                        const content = selectedText || post.content;
                        const label = lang === 'ru' ? `[b]${author}[/b] написал(а):` : `[b]${author}[/b] wrote:`;

                        // BBCode Quote layout without extra trailing newlines to prevent gaps
                        const quote = `[quote]${label}\n${content}[/quote]\n`;

                        setReplyContent(prev => prev + quote);
                        // Clean selection after quoting
                        window.getSelection().removeAllRanges();
                        replyRef.current?.scrollIntoView({ behavior: 'smooth' });
                      }}
                    >
                      {lang === 'ru' ? 'Цитировать' : 'Quote'}
                    </Button>
                  </Col>
                </Row>
              </div>
            </Card.Body>
          </Card>
        ))}
      </div>

      <div className="d-flex justify-content-center p-3">
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          centered
        />
      </div>

      {/* Reply form — hidden for spectators */}
      {
        profile?.role_id !== 'spectator' ? (
          <div className="mt-5" ref={replyRef}>
            <Card className="shadow-sm border-0">
              <Card.Header className="bg-dark text-white py-3">
                <h5 className="mb-0">{t('forum.create_post')}</h5>
              </Card.Header>
              <Card.Body className="p-4">
                <Form onSubmit={handleReply}>
                  <Form.Group className="mb-3" controlId="postAs">
                    <Form.Select
                      size="sm"
                      value={selectedCharacterId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedCharacterId(val);
                        if (user) {
                          updateUser(user.uid, { last_selected_character_id: val });
                        }
                      }}
                      className="mb-2 w-auto"
                    >
                      <option value="">
                        {lang === 'ru' ? 'Как пользователь' : 'Post as User'}:{' '}
                        {profile?.nickname || profile?.email?.split('@')[0]}
                      </option>
                      {characters.map(char => (
                        <option key={char.id} value={char.id}>
                          {lang === 'ru' ? 'Как персонаж' : 'As Character'}: {char.name}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                  <Form.Group className="mb-3">
                    <RichEditor
                      id="replyContent"
                      placeholder={lang === 'ru' ? 'Написать ответ...' : 'Write your reply...'}
                      rows={6}
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      maxLength={MAX_CHARS}
                      disabled={submitting}
                    />
                  </Form.Group>
                  <div className="d-flex justify-content-end">
                    <Button variant="primary" type="submit" className="px-4" disabled={submitting}>
                      {submitting
                        ? (lang === 'ru' ? 'Отправка...' : 'Posting...')
                        : t('forum.create_post')}
                    </Button>
                  </div>
                </Form>
              </Card.Body>
            </Card>
          </div>
        ) : (
          <div className="mt-5 p-4 text-center text-muted border rounded" ref={replyRef}>
            <span className="opacity-75">
              {lang === 'ru'
                ? '👁 Режим наблюдателя — вы можете читать, но не можете публиковать сообщения.'
                : '👁 Spectator mode — you can read but cannot post replies.'}
            </span>
          </div>
        )
      }

      <div className="mt-4">
        <Breadcrumb className="mb-3">
          <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/' }}>{t('nav.home')}</Breadcrumb.Item>
          {category && (
            <Breadcrumb.Item linkAs={Link} linkProps={{ to: `/category/${category.id}` }}>
              {categoryTitle}
            </Breadcrumb.Item>
          )}
          <Breadcrumb.Item active>{topic.title}</Breadcrumb.Item>
        </Breadcrumb>

        <div className="d-flex justify-content-between">
          {category && (
            <Link to={`/category/${category.id}`} className="btn btn-outline-secondary">
              &larr; {t('forum.back_to_categories')}
            </Link>
          )}
        </div>
      </div>

      {/* Modals */}
      <ConfirmModal
        show={!!deletingPost}
        onHide={() => setDeletingPost(null)}
        onConfirm={handleDeletePost}
        title={lang === 'ru' ? 'Удалить пост?' : 'Delete post?'}
        message={lang === 'ru'
          ? 'Это действие необратимо. Пост будет удалён навсегда.'
          : 'This action cannot be undone. The post will be permanently deleted.'}
        confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
        cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
      />

      <ForumModal
        show={showRepModal}
        onHide={() => setShowRepModal(false)}
        title={t('profile.rep_give')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowRepModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleRepVote} disabled={submittingRep}>
              {submittingRep ? t('common.loading') : t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="text-center mb-4">
          <Badge bg={repValue > 0 ? 'success' : 'danger'} className="fs-3 px-4 py-2">
            {repValue > 0 ? `+${repValue}` : repValue}
          </Badge>
          <div className="mt-3 text-muted small px-3">
            {lang === 'ru'
              ? 'Этот голос изменит репутацию данного поста и будет зачислен в общую репутацию (карму) автора.'
              : 'This vote will change the reputation of this post and contribute to the author\'s total reputation (karma).'}
          </div>
        </div>
        <Form.Group>
          <Form.Label className="fw-bold small">{lang === 'ru' ? 'Комментарий (опционально)' : 'Leave a comment (optional)'}</Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={repComment}
            onChange={(e) => setRepComment(e.target.value)}
            placeholder=""
            className="modal-section-themed"
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showVoteInfoModal}
        onHide={() => setShowVoteInfoModal(false)}
        title={lang === 'ru' ? 'Информация о вашем голосе' : 'Your Vote Information'}
        className="premium-modal shadow-lg"
        footer={
          <Button variant="outline-secondary" className="w-100" onClick={() => setShowVoteInfoModal(false)}>
            {t('common.close')}
          </Button>
        }
      >
        {selectedVote && (
          <div className="d-flex flex-column gap-3">
            <div className="d-flex justify-content-between align-items-center modal-inner-card p-3">
              <div>
                <div className="small text-muted">{lang === 'ru' ? 'Ваш голос' : 'Your vote'}</div>
                <Badge bg={selectedVote.value > 0 ? 'success' : 'danger'} className="fs-5 mt-1">
                  {selectedVote.value > 0 ? `+${selectedVote.value}` : selectedVote.value}
                </Badge>
              </div>
              <div className="text-end">
                <div className="small text-muted">{lang === 'ru' ? 'Дата' : 'Date'}</div>
                <div className="fw-bold">{formatTime(selectedVote.created_at)}</div>
              </div>
            </div>

            <div>
              <div className="small text-muted mb-2">{lang === 'ru' ? 'Ваш комментарий' : 'Your comment'}</div>
              <div className="p-3 modal-inner-card border-start border-4 border-accent" style={{ minHeight: '60px' }}>
                {selectedVote.comment || (lang === 'ru' ? <span className="opacity-50 italic">Без комментария</span> : <span className="opacity-50 italic">No comment left</span>)}
              </div>
            </div>

            <div className="small text-muted opacity-75 italic text-center mt-2">
              {lang === 'ru'
                ? 'Этот голос зачислен автору поста.'
                : 'This vote has been contributed to the post author.'}
            </div>
          </div>
        )}
      </ForumModal>

      <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 1100 }}>
        <Toast
          bg={toast.variant}
          show={toast.show}
          onClose={() => setToast(t => ({ ...t, show: false }))}
          delay={3500}
          autohide
        >
          <Toast.Body className="d-flex align-items-center gap-2 text-white fw-semibold">
            <span>{toast.variant === 'success' ? '✓' : '✕'}</span>
            <span>{toast.message}</span>
          </Toast.Body>
        </Toast>
      </ToastContainer>
    </Container >
  );
};

export default TopicPage;
