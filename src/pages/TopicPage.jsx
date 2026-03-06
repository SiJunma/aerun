import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Breadcrumb, Button, Form, Modal, Pagination } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToPosts, createPost, updatePost, deletePost, subscribeToTopic, subscribeToCategories, subscribeToUser, updateUser } from '../api/forum';
import { subscribeToCharacters } from '../api/character';
import ConfirmModal from '../components/common/ConfirmModal';
import { formatDistanceToNow } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

const TopicPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { profile, user } = useAuth();
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

  // Delete confirmation state
  const [deletingPost, setDeletingPost] = useState(null);

  const replyRef = useRef(null);
  const scrolledRef = useRef(false); // prevent double-scroll
  const goLast = searchParams.get('goLast') === '1';
  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);
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
    };
  }, [id]);

  // Subscribe to characters separately so we can unsubscribe properly
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToCharacters(user.uid, setCharacters);
    return () => unsub();
  }, [user]);

  // Set initial selectedCharacterId from profile
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
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
  }, [posts.length > 0 ? [...new Set(posts.map(p => p.author_id))].join(',') : '']);

  // Scroll to first unread post (or last post if ?goLast=1)
  useEffect(() => {
    if (posts.length === 0 || scrolledRef.current) return;

    let targetId;
    let targetPage = currentPage;

    if (goLast) {
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
  }, [posts.length, goLast, currentPage]);

  const Toolbar = ({ target = 'reply' }) => (
    <div className="d-flex gap-2 mb-2 p-2 border rounded bg-light editor-toolbar">
      <Button variant="light" size="sm" onClick={() => insertText('**', '**', false, target)} title="Bold"><strong>B</strong></Button>
      <Button variant="light" size="sm" onClick={() => insertText('*', '*', false, target)} title="Italic"><em>I</em></Button>
      <Button variant="light" size="sm" onClick={() => insertText('<u>', '</u>', false, target)} title="Underline"><u>U</u></Button>
      <Button variant="light" size="sm" onClick={() => insertText('~~', '~~', false, target)} title="Strikethrough"><del>S</del></Button>
      <div className="vr mx-1"></div>
      <Button variant="light" size="sm" onClick={() => insertText('[TEXT](URL)', '', true, target)} title="Link">Link</Button>
      <Button variant="light" size="sm" onClick={() => insertText('![alt](URL)', '', true, target)} title="Image">Img</Button>
      <div className="vr mx-1"></div>
      <Button variant="light" size="sm" onClick={() => insertText('', '', 'quote', target)} title="Quote">Quote</Button>
    </div>
  );

  const formatTime = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return formatDistanceToNow(date, { addSuffix: true, locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const getLiveAuthorName = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char?.name || post.author_name;
      }
      return profile?.nickname || post.author_name;
    }
    return authorStats[post.author_id]?.nickname || post.author_name;
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

  const getLiveShowFooter = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.show_footer !== false) : (post.show_footer !== false);
      }
      return (profile?.settings?.show_footer !== false);
    }
    const stats = authorStats[post.author_id];
    return (stats && stats.nickname) ? (stats.settings?.show_footer !== false) : (post.show_footer !== false);
  };

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';

  const insertText = (before, after = '', isLink = false, target = 'reply') => {
    const fieldId = target === 'reply' ? 'replyContent' : 'editContent';
    const textarea = document.getElementById(fieldId);
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.substring(start, end);

    let replacement = '';
    if (isLink === 'quote') {
      const author = prompt(lang === 'ru' ? 'Кто это написал?' : 'Who wrote this?', '');
      const label = author ? (lang === 'ru' ? `**${author}** написал(а):` : `**${author}** wrote:`) : '';
      if (label) {
        replacement = `> ${label}\n>\n> ${selected || '...'}`;
      } else {
        replacement = `> ${selected || '...'}`;
      }
    } else if (isLink) {
      const url = prompt(lang === 'ru' ? 'Введите URL:' : 'Enter URL:', 'https://');
      if (!url) return;
      replacement = before.replace('URL', url).replace('TEXT', selected || 'text');
    } else {
      replacement = before + selected + after;
    }

    const newValue = text.substring(0, start) + replacement + text.substring(end);
    if (target === 'reply') setReplyContent(newValue);
    else setEditContent(newValue);

    // Set focus back and adjust selection
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + replacement.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

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
        author_character_id: selectedCharacterId || null,
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
        show_footer: selectedChar
          ? (selectedChar.show_footer !== false)
          : (profile?.settings?.show_footer !== false),
        owner_name: profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'
      };

      await createPost(postData);
      setReplyContent('');
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
      // Find the post to get is_character and author_character_id
      const post = posts.find(p => p.id === postId);
      let metadata = {};

      if (post && post.author_id === user?.uid) {
        const selectedChar = post.is_character
          ? characters.find(c => c.id === post.author_character_id || c.name === post.author_name)
          : null;

        metadata = {
          author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || 'User'),
          author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || user?.photoURL || ''),
          author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
          author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
          show_footer: selectedChar ? (selectedChar.show_footer !== false) : (profile?.settings?.show_footer !== false)
        };
      }

      await updatePost(postId, editContent.trim(), metadata);
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

  // Pagination logic
  const totalPages = Math.ceil(posts.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentPosts = posts.slice(indexOfFirstItem, indexOfLastItem);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0 });
  };

  const renderPagination = () => {
    if (totalPages <= 1) return null;
    return (
      <Pagination className="mb-0">
        <Pagination.First onClick={() => handlePageChange(1)} disabled={currentPage === 1} />
        <Pagination.Prev onClick={() => handlePageChange(Math.max(1, currentPage - 1))} disabled={currentPage === 1} />
        {[...Array(totalPages)].map((_, i) => (
          <Pagination.Item
            key={i + 1}
            active={i + 1 === currentPage}
            onClick={() => handlePageChange(i + 1)}
          >
            {i + 1}
          </Pagination.Item>
        ))}
        <Pagination.Next onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} />
        <Pagination.Last onClick={() => handlePageChange(totalPages)} disabled={currentPage === totalPages} />
      </Pagination>
    );
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
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
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
        <div>
          {renderPagination()}
        </div>
      </div>

      {/* Posts */}
      <div className="posts-container">
        {currentPosts.map((post, index) => (
          <Card key={post.id} id={`post-${post.id}`} className="mb-4 shadow-sm border-0 post-card">
            <Card.Body className="p-0">
              <Row className="g-0">
                {/* Author sidebar */}
                <Col md={3} lg={2} className="author-sidebar border-end px-3 py-2 text-center d-flex flex-column align-items-center">
                  {/* 1. Nickname */}
                  <div className="fw-bold mt-2 mb-1 text-break" style={{ fontSize: '0.95rem' }}>
                    {getLiveAuthorName(post)}
                  </div>

                  {/* 2. Status */}
                  {getLiveAuthorStatus(post) && (
                    <div className="text-primary small mb-2 text-truncate w-100 px-2" style={{ fontStyle: 'italic', lineHeight: '1.2' }}>
                      {getLiveAuthorStatus(post)}
                    </div>
                  )}

                  {/* 3. Avatar */}
                  <Image
                    src={getLiveAuthorAvatar(post) || `https://ui-avatars.com/api/?name=${encodeURIComponent(getLiveAuthorName(post))}&background=random`}
                    rounded
                    fluid
                    className="mb-2 shadow-sm"
                    style={{ width: '90px', height: '90px', objectFit: 'cover' }}
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(getLiveAuthorName(post) || '?')}&background=444&color=fff`;
                    }}
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
                      {formatTime(post.created_at)}
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
                          <Toolbar target="edit" />
                          <Form.Control
                            id="editContent"
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
                        <div className="post-content">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw, rehypeSanitize]}
                          >
                            {post.content}
                          </ReactMarkdown>
                        </div>
                      )}

                      {/* Signature */}
                      {getLiveShowFooter(post) && getLiveAuthorSignature(post) && (
                        <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                          {getLiveAuthorSignature(post)}
                        </div>
                      )}
                    </div>

                    {/* Reputation */}
                    <div className="mt-3 d-flex justify-content-end align-items-center gap-2">
                      <div className="reputation-controls d-flex align-items-center">
                        <strong className="me-2" style={{ color: 'var(--accent-color)' }}>{authorStats[post.author_id]?.reputation || 0}</strong>
                        {post.author_id !== profile?.uid && (
                          <>
                            <Button variant="outline-danger" className="rep-btn" onClick={() => { }}>−</Button>
                            <Button variant="outline-success" className="rep-btn" onClick={() => { }}>+</Button>
                          </>
                        )}
                      </div>
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
                          onClick={() => handleStartEdit(post)}
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
                        const label = lang === 'ru' ? `**${author}** написал(а):` : `**${author}** wrote:`;

                        // New boxed layout with paragraph break
                        const quote = `> ${label}\n>\n> ${content.split('\n').join('\n> ')}\n\n`;

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

      <div className="d-flex justify-content-center mt-4 mb-4">
        {renderPagination()}
      </div>

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
              <Form.Group className="mb-3" controlId="replyContent">
                <Toolbar target="reply" />
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
    </Container >
  );
};

export default TopicPage;
