import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Breadcrumb, Button, Form } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToPosts, createPost, subscribeToTopics, subscribeToCategories } from '../api/forum';
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

  const MAX_CHARS = 5000;

  useEffect(() => {
    const unsubPosts = subscribeToPosts(id, setPosts);
    const unsubTopic = subscribeToTopics('', (allTopics) => {
       // Note: subscribeToTopics normally needs categoryId, but for now we look in all topics if possible 
       // Or we update forum.js to support getTopicById. Let's assume we fetch by ID if we had that.
       // For MVP, since we don't have getTopicById, we scan. 
       const found = allTopics.find(t => t.id === id);
       if (found) setTopic(found);
    });

    if (user) {
      const unsubChars = subscribeToCharacters(user.uid, setCharacters);
      return () => {
        unsubChars();
        unsubPosts();
        unsubTopic();
      };
    }
    return () => {
      unsubPosts();
      unsubTopic();
    };
  }, [id, user]);

  useEffect(() => {
    if (topic?.category_id) {
      const unsubCat = subscribeToCategories((cats) => {
        const found = cats.find(c => c.id === topic.category_id);
        if (found) setCategory(found);
      });
      return () => unsubCat();
    }
  }, [topic?.category_id]);

  const handleReply = async (e) => {
    e.preventDefault();
    if (!replyContent || submitting) return;

    setSubmitting(true);
    try {
      const selectedChar = characters.find(c => c.id === selectedCharacterId);
      
      const postData = {
        topic_id: id,
        content: replyContent,
        author_id: user.uid,
        author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'),
        author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || user?.photoURL || ''),
        is_character: !!selectedChar,
        character_title: selectedChar?.title || '',
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
        show_footer: selectedChar ? (selectedChar.show_footer !== false) : (profile?.settings?.show_footer !== false)
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

  const formatTime = (timestamp) => {
    if (!timestamp) return '...';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return formatDistanceToNow(date, { 
      addSuffix: true, 
      locale: lang === 'ru' ? ru : enUS 
    });
  };

  if (!topic) return <Container className="py-5">Loading...</Container>;

  return (
    <Container className="py-4">
      <Breadcrumb className="mb-4">
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: "/" }}>{t('nav.home')}</Breadcrumb.Item>
        {category && (
          <Breadcrumb.Item linkAs={Link} linkProps={{ to: `/category/${category.id}` }}>
            {typeof category.title === 'object' ? (lang === 'ru' ? category.title.ru : category.title.en) : category.title}
          </Breadcrumb.Item>
        )}
        <Breadcrumb.Item active>{topic.title}</Breadcrumb.Item>
      </Breadcrumb>
 
      <h2 className="mb-4">{topic.title}</h2>
 
      {posts.map(post => (
        <Card key={post.id} className="mb-4 shadow-sm border-0 post-card">
          <Card.Body className="p-0">
            <Row className="g-0">
              {/* Left Column: Author Info */}
              <Col md={3} lg={2} className="author-sidebar border-end p-3 text-center d-flex flex-column align-items-center">
                <Image 
                  src={post.author_avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(post.author_name)}&background=random`} 
                  rounded 
                  fluid 
                  className="mb-3 shadow-sm"
                  style={{ width: '100px', height: '100px', objectFit: 'cover' }}
                  referrerPolicy="no-referrer"
                  onError={(e) => { 
                    e.target.onerror = null; 
                    e.target.src = 'https://ui-avatars.com/api/?name=?&background=666&color=fff'; 
                  }}
                />
                <div className="fw-bold h5 mb-0 text-break">
                  {post.author_name}
                </div>
                {post.is_character && post.character_title && (
                  <div className="text-primary small mb-2">{post.character_title}</div>
                )}
                {!post.is_character && (
                  <Badge bg="secondary" className="mb-2 opacity-75">Member</Badge>
                )}
              </Col>
 
              {/* Right Column: Post Content */}
              <Col md={9} lg={10} className="p-4 d-flex flex-column">
                <div className="d-flex justify-content-between align-items-center mb-3">
                  <small className="text-muted">{formatTime(post.created_at)}</small>
                  <div className="post-actions">
                    <Button variant="link" size="sm" className="text-decoration-none">Quote</Button>
                  </div>
                </div>
                
                <div className="post-content flex-grow-1" style={{ whiteSpace: 'pre-line' }}>
                  {post.content}
                </div>
 
                {post.show_footer && post.author_signature && (
                   <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed !important' }}>
                     {post.author_signature}
                   </div>
                )}

                {post.is_character && (
                   <div className="mt-2 small text-muted opacity-50">
                     OOC: Posting as character {post.author_name}
                   </div>
                )}
              </Col>
            </Row>
          </Card.Body>
        </Card>
      ))}
 
      <div className="mt-5">
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
                  <option value="">Post as User: {profile?.email?.split('@')[0]}</option>
                  {characters.map(char => (
                    <option key={char.id} value={char.id}>
                      As Character: {char.name}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Form.Group className="mb-3" controlId="replyContent">
                <Form.Control 
                  as="textarea" 
                  rows={5} 
                  placeholder="Write your reply..." 
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
                  {submitting ? 'Posting...' : t('forum.create_post')}
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
    </Container>
  );
};

export default TopicPage;
