import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Breadcrumb } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToCharacters } from '../api/character';
import { subscribeToCategories, createTopic } from '../api/forum';

const TopicFormPage = () => {
  const { categoryId } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const { profile, user } = useAuth();
  
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [category, setCategory] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      const unsubChars = subscribeToCharacters(user.uid, setCharacters);
      const unsubCats = subscribeToCategories((cats) => {
        const found = cats.find(c => c.id === categoryId);
        if (found) setCategory(found);
      });
      return () => {
        unsubChars();
        unsubCats();
      };
    }
  }, [user, categoryId]);

  const LIMITS = {
    title: 100,
    description: 200,
    content: 5000
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title || !content || submitting) return;

    setSubmitting(true);
    try {
      const selectedChar = characters.find(c => c.id === selectedCharacterId);
      
      const topicData = {
        category_id: categoryId,
        title,
        description,
        author_id: user.uid,
        author_name: selectedChar ? selectedChar.name : (profile?.email?.split('@')[0] || 'User'),
        author_avatar: selectedChar ? selectedChar.avatar_url : (user?.photoURL || ''),
        is_character: !!selectedChar
      };

      const firstPostData = {
        content,
        author_id: user.uid,
        author_name: topicData.author_name,
        author_avatar: topicData.author_avatar,
        is_character: topicData.is_character
      };

      await createTopic(topicData, firstPostData);
      navigate(`/category/${categoryId}`);
    } catch (err) {
      console.error(err);
      alert('Error creating topic');
    } finally {
      setSubmitting(false);
    }
  };

  const categoryTitle = category ? (
    typeof category.title === 'object' ? (lang === 'ru' ? category.title.ru : category.title.en) : category.title
  ) : '...';

  return (
    <Container className="py-4">
      <Breadcrumb className="mb-4">
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: "/" }}>{t('nav.home')}</Breadcrumb.Item>
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: `/category/${categoryId}` }}>
          {categoryTitle}
        </Breadcrumb.Item>
        <Breadcrumb.Item active>{t('forum.create_topic')}</Breadcrumb.Item>
      </Breadcrumb>
 
      <Card className="shadow-sm border-0">
        <Card.Header className="py-3">
          <h4 className="mb-0">{t('forum.create_topic')}</h4>
        </Card.Header>
        <Card.Body className="p-4">
          <Form onSubmit={handleSubmit}>
            <Form.Group className="mb-4" controlId="topicTitle">
              <Form.Label className="fw-bold h6">Topic Title / Заголовок темы</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Enter topic title..." 
                className="form-control-lg"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={LIMITS.title}
                required
              />
              <div className="text-end mt-1">
                <small className={`${title.length >= LIMITS.title ? 'text-danger' : 'text-muted'}`}>
                  {title.length} / {LIMITS.title}
                </small>
              </div>
            </Form.Group>
 
            <Form.Group className="mb-4" controlId="topicDesc">
              <Form.Label className="fw-bold h6">{t('forum.short_description')}</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Briefly describe what this topic is about..." 
                className="bg-light"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={LIMITS.description}
              />
              <div className="text-end mt-1">
                <small className={`${description.length >= LIMITS.description ? 'text-danger' : 'text-muted'}`}>
                  {description.length} / {LIMITS.description}
                </small>
              </div>
            </Form.Group>
 
            <Form.Group className="mb-4" controlId="postAs">
              <Form.Label className="fw-bold h6">{t('forum.post_as')}</Form.Label>
              <Form.Select 
                value={selectedCharacterId}
                onChange={(e) => setSelectedCharacterId(e.target.value)}
                className="bg-light"
              >
                <option value="">User: {profile?.email?.split('@')[0] || t('nav.profile')}</option>
                {characters.map(char => (
                  <option key={char.id} value={char.id}>
                    Character: {char.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
 
            <Form.Group className="mb-4" controlId="topicContent">
              <Form.Label className="fw-bold h6">Content / Содержание</Form.Label>
              <Form.Control 
                as="textarea" 
                rows={10} 
                placeholder="Write your message here..." 
                className="bg-light"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={LIMITS.content}
                required
              />
              <div className="d-flex justify-content-between mt-2">
                <Form.Text className="text-muted">
                  Markdown is supported.
                </Form.Text>
                <Form.Text className={`${content.length >= LIMITS.content ? 'text-danger' : 'text-muted'} fw-bold`}>
                  {content.length} / {LIMITS.content}
                </Form.Text>
              </div>
            </Form.Group>
 
            <div className="d-flex justify-content-end gap-2">
              <Button 
                variant="outline-secondary" 
                disabled={submitting}
                onClick={() => navigate(`/category/${categoryId}`)}
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" className="px-4" disabled={submitting}>
                {submitting ? 'Creating...' : t('forum.create_topic')}
              </Button>
            </div>
          </Form>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default TopicFormPage;
