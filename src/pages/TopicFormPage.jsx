import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Container, Card, Form, Button, Dropdown } from 'react-bootstrap';
import { User } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToCharacters } from '../api/character';
import { subscribeToCategories, createTopic, updateUser } from '../api/forum';
import RichEditor from '../components/common/RichEditor';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';

const TopicFormPage = () => {
  const { categoryId } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const { profile, user, recordActivity, markTopicRead, hasPermission, PERMISSIONS } = useAuth();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [category, setCategory] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const DRAFT_KEY = `topic_draft_${categoryId}`;

  useEffect(() => {
    if (user) {
      const unsubChars = subscribeToCharacters(user.uid, setCharacters);
      const unsubCats = subscribeToCategories((cats) => {
        const found = cats.find(c => c.id === categoryId);
        if (found) setCategory(found);
      });

      // Load draft once on mount
      if (!draftLoaded) {
        try {
          const savedDraft = localStorage.getItem(DRAFT_KEY);
          if (savedDraft) {
            const { title: dTitle, description: dDesc, content: dContent } = JSON.parse(savedDraft);
            if (dTitle) setTitle(dTitle);
            if (dDesc) setDescription(dDesc);
            if (dContent) setContent(dContent);
          }
        } catch (e) {
          console.error('Error loading draft', e);
        }
        setDraftLoaded(true);
      }

      return () => {
        unsubChars();
        unsubCats();
      };
    }
  }, [user, categoryId, draftLoaded, DRAFT_KEY]);

  // Save draft whenever fields change
  useEffect(() => {
    if (draftLoaded) {
      if (title.trim() || description.trim() || content.trim()) {
        const draft = { title, description, content };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    }
  }, [title, description, content, draftLoaded, DRAFT_KEY]);


  const LIMITS = {
    title: 100,
    description: 200,
    content: 15000
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title || !content || submitting) return;

    setSubmitting(true);
    recordActivity();
    try {
      const selectedChar = characters.find(c => c.id === selectedCharacterId);

      const authorName = selectedChar
        ? selectedChar.name
        : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User');

      const topicData = {
        category_id: categoryId,
        title,
        description,
        author_id: user.uid,
        author_name: authorName,
        author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
        author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
        author_role_id: profile?.role_id || 'player',
        is_character: !!selectedChar,
        author_character_id: selectedCharacterId || null
      };

      const firstPostData = {
        content,
        author_id: user.uid,
        author_name: authorName,
        author_avatar: topicData.author_avatar,
        author_status_line: topicData.author_status_line,
        author_role_id: topicData.author_role_id,
        is_character: topicData.is_character,
        author_character_id: topicData.author_character_id,
        character_title: selectedChar?.title || '',
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || '')
      };

      const newTopicId = await createTopic(topicData, firstPostData);
      localStorage.removeItem(DRAFT_KEY);
      // Mark as read immediately (server-side, all roles)
      await markTopicRead(newTopicId);
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

  if (!category) {
    return (
      <Container className="py-5 text-center">
        <div className="spinner-border text-primary" role="status" />
      </Container>
    );
  }

  if (!hasPermission(PERMISSIONS.CREATE_TOPIC, { category })) {
    return (
      <Container className="py-5 text-center">
        <h3 className="text-muted">{lang === 'ru' ? 'Доступ запрещён' : 'Access Denied'}</h3>
        <p className="text-muted">{lang === 'ru' ? 'У вас нет прав для создания тем в этой категории.' : 'You do not have permission to create topics in this category.'}</p>
        <Button as={Link} to="/" variant="outline-primary" className="mt-3">
          {lang === 'ru' ? 'На главную' : 'Go Home'}
        </Button>
      </Container>
    );
  }

  return (
    <Container className="py-4">
      <ForumBreadcrumbs 
        items={[
          { label: categoryTitle, to: `/category/${categoryId}` },
          { label: t('forum.create_topic'), active: true }
        ]} 
      />

      <Card className="shadow-sm border-0">
        <Card.Header className="py-3">
          <h4 className="mb-0">{t('forum.create_topic')}</h4>
        </Card.Header>
        <Card.Body className="p-3 p-md-4">
          <Form onSubmit={handleSubmit}>
            <Form.Group className="mb-3" controlId="topicTitle">
              <div className="d-flex justify-content-between align-items-center mb-1">
                <Form.Label className="fw-bold h6 mb-0">{t('forum.topic_title')}</Form.Label>
                <small className={`${title.length >= LIMITS.title ? 'text-danger' : 'text-muted'}`}>
                  {title.length} / {LIMITS.title}
                </small>
              </div>
              <Form.Control
                type="text"
                placeholder="Enter topic title..."
                className=""
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={LIMITS.title}
                required
              />
            </Form.Group>

            <Form.Group className="mb-3" controlId="topicDesc">
              <div className="d-flex justify-content-between align-items-center mb-1">
                <Form.Label className="fw-bold h6 mb-0">{t('forum.short_description')}</Form.Label>
                <small className={`${description.length >= LIMITS.description ? 'text-danger' : 'text-muted'}`}>
                  {description.length} / {LIMITS.description}
                </small>
              </div>
              <Form.Control
                type="text"
                placeholder="Briefly describe what this topic is about..."
                className=""
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={LIMITS.description}
              />
            </Form.Group>

            {hasPermission(PERMISSIONS.USE_MASKS, { category }) && (
              <Form.Group className="mb-3" controlId="postAs">
                <Form.Label className="fw-bold h6">{t('forum.post_as')}</Form.Label>
                <Dropdown className="w-100">
                  <Dropdown.Toggle 
                    variant="outline-management" 
                    className="d-flex align-items-center gap-2 w-100 justify-content-between custom-select-toggle"
                  >
                    <div className="d-flex align-items-center gap-2 text-truncate">
                      <User size={18} />
                      <span className="text-truncate">
                        {selectedCharacterId 
                          ? `${lang === 'ru' ? 'Персонаж' : 'Character'}: ${characters.find(c => c.id === selectedCharacterId)?.name || '...'}`
                          : `User: ${profile?.nickname || profile?.email?.split('@')[0] || t('nav.profile')}`
                        }
                      </span>
                    </div>
                  </Dropdown.Toggle>
                  <Dropdown.Menu className="shadow-sm border-0 w-100 custom-select-menu">
                    <Dropdown.Item 
                      active={selectedCharacterId === ''}
                      onClick={() => {
                        setSelectedCharacterId('');
                        if (user) updateUser(user.uid, { last_selected_character_id: '' });
                      }}
                    >
                      User: {profile?.nickname || profile?.email?.split('@')[0]}
                    </Dropdown.Item>
                    {characters.length > 0 && <Dropdown.Divider />}
                    {characters.map(char => (
                      <Dropdown.Item 
                        key={char.id}
                        active={selectedCharacterId === char.id}
                        onClick={() => {
                          setSelectedCharacterId(char.id);
                          if (user) updateUser(user.uid, { last_selected_character_id: char.id });
                        }}
                      >
                        {lang === 'ru' ? 'Персонаж' : 'Character'}: {char.name}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              </Form.Group>
            )}

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold h6">{lang === 'ru' ? 'Содержание' : 'Content'}</Form.Label>
              <RichEditor
                id="topicContent"
                placeholder={lang === 'ru' ? 'Напишите ваше сообщение здесь...' : 'Write your message here...'}
                rows={10}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={LIMITS.content}
                disabled={submitting}
                showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                isEdit={false}
              />
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
