import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Breadcrumb, Button, Form, Modal } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToPosts, createPost, updatePost, deletePost, subscribeToTopic, subscribeToCategories } from '../api/forum';
import { subscribeToCharacters } from '../api/character';
import { formatDistanceToNow } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const TopicPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { profile, user } = useAuth();
  const [replyContent, setReplyContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [topic, setTopic] = useState(null);
  const [category, setCategory] = useState(null);
  const [posts, setPosts] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // Edit state
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState('');

  // Delete confirmation state
  const [deletingPost, setDeletingPost] = useState(null);

  const replyRef = useRef(null);
  const scrolledRef = useRef(false); // prevent double-scroll
  const [searchParams] = useSearchParams();
  const goLast = searchParams.get('goLast') === '1';
  const MAX_CHARS = 5000;
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
      if (user) {
        subscribeToCharacters(user.uid, () => {}).call;
      }
    };
  }, [id]);

  // Subscribe to characters separately so we can unsubscribe properly
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToCharacters(user.uid, setCharacters);
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (topic?.category_id) {
      const unsubCat = subscribeToCategories((cats) => {
        const found = cats.find(c => c.id === topic.category_id);
        if (found) setCategory(found);
      });
      return () => unsubCat();
    }
  }, [topic?.category_id]);

  // Scroll to first unread post (or last post if ?goLast=1)
  useEffect(() => {
    if (posts.length === 0 || scrolledRef.current) return;
    scrolledRef.current = true;

    let targetId;
    if (goLast) {
      // Scroll to last post
      targetId = `post-${posts[posts.length - 1].id}`;
    } else {
      // Find first post newer than last visit
      const lastVisit = parseInt(localStorage.getItem(LAST_VISIT_KEY) || '0', 10);
      const firstUnread = posts.find(p => {
        const ms = p.created_at?.toMillis?.() ?? 0;
        return ms > lastVisit;
      });
      if (firstUnread) {
        targetId = `post-${firstUnread.id}`;
      }
    }

    if (targetId) {
      setTimeout(() => {
        const el = document.getElementById(targetId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
  }, [posts]);

  const formatTime = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return formatDistanceToNow(date, { addSuffix: true, locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';

  const handleReply = async (e) => {
    e.preventDefault();
    if (!replyContent.trim() || submitting) return;

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
        character_title: selectedChar?.title || '',
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
        show_footer: selectedChar
          ? (selectedChar.show_footer !== false)
          : (profile?.settings?.show_footer !== false)
      };

      await createPost(postData);
      setReplyContent('');
      setSelectedCharacterId('');
    } catch (err) {
      console.error(err);
      alert('Error posting reply');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartEdit = (post) => {
    setEditingPostId(post.id);
    setEditContent(post.content);
  };

  const handleSaveEdit = async (postId) => {
    if (!editContent.trim()) return;
    try {
      await updatePost(postId, editContent.trim());
      setEditingPostId(null);
      setEditContent('');
    } catch (err) {
      console.error(err);
      alert('Error editing post');
    }
  };

  const handleDeletePost = async () => {
    if (!deletingPost) return;
    try {
      await deletePost(deletingPost);
      setDeletingPost(null);
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
      <div className="mb-4">
        <h2 className="mb-1">{topic.title}</h2>
        {topic.description && (
          <p className="text-muted mb-2">{topic.description}</p>
        )}
        <div className="d-flex gap-3 small text-muted">
          <span>
            {lang === 'ru' ? 'Автор' : 'Author'}:{' '}
            <span className="text-primary fw-semibold">{topic.author_name}</span>
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
      </div>

      {/* Posts */}
      {posts.map((post, index) => (
        <Card key={post.id} id={`post-${post.id}`} className="mb-4 shadow-sm border-0 post-card">
          <Card.Body className="p-0">
            <Row className="g-0">
              {/* Author sidebar */}
              <Col md={3} lg={2} className="author-sidebar border-end p-3 text-center d-flex flex-column align-items-center">
                <Image
                  src={post.author_avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(post.author_name)}&background=random`}
                  rounded
                  fluid
                  className="mb-2 shadow-sm"
                  style={{ width: '90px', height: '90px', objectFit: 'cover' }}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    e.target.onerror = null;
                    e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(post.author_name || '?')}&background=444&color=fff`;
                  }}
                />
                <div className="fw-bold mb-0 text-break" style={{ fontSize: '0.95rem' }}>
                  {post.author_name}
                </div>
                {/* Decorative status line */}
                {post.author_status_line && (
                  <div className="text-primary small mb-1" style={{ fontStyle: 'italic' }}>
                    {post.author_status_line}
                  </div>
                )}
                {/* Role / character badge */}
                {post.is_character && post.character_title ? (
                  <Badge bg="info" text="dark" className="mb-1 mt-1 opacity-90" style={{ fontSize: '0.7rem' }}>
                    {post.character_title}
                  </Badge>
                ) : (
                  <div className="mt-1">{getRoleBadge(post)}</div>
                )}
                {post.is_character && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.7rem', opacity: 0.6 }}>
                    {lang === 'ru' ? 'персонаж' : 'character'}
                  </div>
                )}
                {/* Post number */}
                <div className="text-muted mt-auto" style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                  #{index + 1}
                </div>
              </Col>

              {/* Post content */}
              <Col md={9} lg={10} className="p-4 d-flex flex-column">
                <div className="d-flex justify-content-between align-items-center mb-3">
                  <small className="text-muted">
                    {formatTime(post.created_at)}
                    {post.edited_at && (
                      <span className="ms-2 opacity-50">
                        ({lang === 'ru' ? 'ред.' : 'edited'} {formatTime(post.edited_at)})
                      </span>
                    )}
                  </small>

                  <div className="d-flex gap-1">
                    <Button
                      variant="link"
                      size="sm"
                      className="text-decoration-none text-muted p-1"
                      onClick={() => {
                        setReplyContent(`> ${post.author_name} написал(а):\n> ${post.content.split('\n').join('\n> ')}\n\n`);
                        replyRef.current?.scrollIntoView({ behavior: 'smooth' });
                      }}
                    >
                      {lang === 'ru' ? 'Цитата' : 'Quote'}
                    </Button>

                    {canManagePost(post) && (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          className="text-decoration-none text-muted p-1"
                          onClick={() => handleStartEdit(post)}
                        >
                          {lang === 'ru' ? 'Изменить' : 'Edit'}
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          className="text-decoration-none text-danger p-1"
                          onClick={() => setDeletingPost(post)}
                        >
                          {lang === 'ru' ? 'Удалить' : 'Delete'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Content or edit form */}
                {editingPostId === post.id ? (
                  <div>
                    <Form.Control
                      as="textarea"
                      rows={6}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="mb-2"
                    />
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
                  <div className="post-content flex-grow-1" style={{ whiteSpace: 'pre-line' }}>
                    {post.content}
                  </div>
                )}

                {/* Signature */}
                {post.show_footer && post.author_signature && (
                  <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                    {post.author_signature}
                  </div>
                )}
              </Col>
            </Row>
          </Card.Body>
        </Card>
      ))}

      {/* Reply form */}
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
                  onChange={(e) => setSelectedCharacterId(e.target.value)}
                  className="bg-light mb-2 w-auto"
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
              <Form.Group className="mb-3" controlId="replyContent">
                <Form.Control
                  as="textarea"
                  rows={5}
                  placeholder={lang === 'ru' ? 'Написать ответ...' : 'Write your reply...'}
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  maxLength={MAX_CHARS}
                  disabled={submitting}
                  required
                />
                <div className="text-end mt-1">
                  <small className={`${replyContent.length >= MAX_CHARS ? 'text-danger' : 'text-muted'} fw-bold`}>
                    {replyContent.length} / {MAX_CHARS}
                  </small>
                </div>
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

      <div className="d-flex justify-content-between mt-4">
        {category && (
          <Link to={`/category/${category.id}`} className="btn btn-outline-secondary">
            &larr; {t('forum.back_to_categories')}
          </Link>
        )}
      </div>

      {/* Delete confirm modal */}
      <Modal show={!!deletingPost} onHide={() => setDeletingPost(null)} centered>
        <Modal.Header closeButton>
          <Modal.Title>{lang === 'ru' ? 'Удалить пост?' : 'Delete post?'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {lang === 'ru'
            ? 'Это действие необратимо. Пост будет удалён навсегда.'
            : 'This action cannot be undone. The post will be permanently deleted.'}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setDeletingPost(null)}>
            {lang === 'ru' ? 'Отмена' : 'Cancel'}
          </Button>
          <Button variant="danger" onClick={handleDeletePost}>
            {lang === 'ru' ? 'Удалить' : 'Delete'}
          </Button>
        </Modal.Footer>
      </Modal>
    </Container>
  );
};

export default TopicPage;
