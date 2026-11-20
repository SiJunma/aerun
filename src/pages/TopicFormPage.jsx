import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { User, X } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToCharacters } from '../api/character';
import { createTopic } from '../api/forum';
import RichEditor from '../components/common/RichEditor';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';

import { createInFlight } from '../utils/inflight';
import { useToast } from '../contexts/ToastProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import { makeStorageKey } from '../utils/storageScope';
import MaskPicker from '../components/topic/MaskPicker';

const LIMITS = {
  title: 100,
  description: 200,
  content: 20000,
};

const DRAFT_KEY = 'topicDraft';

const TopicFormPage = () => {
  const { categoryId } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const { profile, user, markTopicRead, scheduleForumStateRefresh, hasPermission, PERMISSIONS, settings, categories, setLastSelectedMask } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();

  useEffect(() => {
    setPageTitle(t('forum.create_topic', 'Create Topic'));
  }, [setPageTitle, t, lang]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [category, setCategory] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlightRef = useRef(null);
  if (submitInFlightRef.current === null) {
    submitInFlightRef.current = createInFlight();
  }
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [pinFirstPost, setPinFirstPost] = useState(false);
  const [guestNickname, setGuestNickname] = useState(() => {
    try {
      return localStorage.getItem(makeStorageKey('guest_nickname', 'guest')) || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    if (!guestNickname) return;
    try {
      localStorage.setItem(makeStorageKey('guest_nickname', 'guest'), guestNickname);
    } catch {
      // localStorage may be unavailable in private mode; degrade gracefully.
    }
  }, [guestNickname]);

  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    if (settings?.enableCharacters === false) {
      setSelectedCharacterId('');
      if (user) setLastSelectedMask('');
    }
  }, [profile, settings, selectedCharacterId, user, setLastSelectedMask]);

  useEffect(() => {
    let mounted = true;
    let characterUnsub = () => {};

    (async () => {
      try {
        const cat = categories?.find(c => c.id === categoryId);
        if (mounted) setCategory(cat || null);
      } catch {
        if (mounted) setCategory(null);
      }

      const canUseMasks = settings?.enableCharacters !== false && hasPermission(PERMISSIONS.USE_MASKS, { category });
      if (user && canUseMasks) {
        characterUnsub = subscribeToCharacters(user.uid, (charList) => {
          if (mounted) setCharacters(charList || []);
        });
      } else if (mounted) {
        setCharacters([]);
      }

      const draftKey = user
        ? makeStorageKey(DRAFT_KEY, categoryId)
        : `${DRAFT_KEY}_guest`;
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const draft = JSON.parse(raw);
          if (mounted) {
            if (draft.title) setTitle(draft.title);
            if (draft.description) setDescription(draft.description);
            if (draft.content) setContent(draft.content);
            if (draft.characterId) setSelectedCharacterId(draft.characterId);
            if (draft.pinFirstPost) setPinFirstPost(draft.pinFirstPost);
            if (!user && draft.guestNickname) setGuestNickname(draft.guestNickname);
            setDraftLoaded(true);
          }
        } else if (mounted) {
          setDraftLoaded(true);
        }
      } catch {
        if (mounted) setDraftLoaded(true);
      }
    })();

    return () => {
      mounted = false;
      characterUnsub();
    };
  }, [categoryId, user, settings, hasPermission, PERMISSIONS, category]);

  useEffect(() => {
    if (!draftLoaded) return;
    const draftKey = user
      ? makeStorageKey(DRAFT_KEY, categoryId)
      : `${DRAFT_KEY}_guest`;
    const draft = {
      title,
      description,
      content,
      characterId: selectedCharacterId,
      pinFirstPost,
      guestNickname: user ? undefined : guestNickname,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Ignore quota/private-mode errors
    }
  }, [title, description, content, selectedCharacterId, pinFirstPost, guestNickname, draftLoaded, user, categoryId]);

  const canUseMasks = user && hasPermission(PERMISSIONS.USE_MASKS, { category }) && settings?.enableCharacters !== false;

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!submitInFlightRef.current.tryEnter()) return;

    if (!title.trim()) {
      submitInFlightRef.current.exit();
      return;
    }
    if (!content.trim()) {
      submitInFlightRef.current.exit();
      return;
    }
    if (!user && !guestNickname.trim()) {
      submitInFlightRef.current.exit();
      return;
    }

    setSubmitting(true);
    try {
      const selectedChar = characters.find(c => c.id === selectedCharacterId);
      const topicData = {
        category_id: categoryId,
        title: title.trim(),
        description: description.trim(),
        pin_first_post: pinFirstPost,
        character_id: selectedCharacterId || '',
      };
      const firstPostData = {
        content,
        author_id: user?.uid || '',
        character_title: selectedChar?.title || '',
        guest_nickname: guestNickname || '',
      };

      const newTopic = await createTopic(topicData, firstPostData);
      const newTopicId = newTopic.id;
      if (!newTopicId) {
        throw new Error('The topic was created but the server did not return its id.');
      }
      scheduleForumStateRefresh(0);
      localStorage.removeItem(user
        ? makeStorageKey(DRAFT_KEY, categoryId)
        : `${DRAFT_KEY}_guest`);
      await markTopicRead(newTopicId);
      navigate(`/topic/${newTopicId}`);

    } catch (err) {
      console.error(err);
      if (err?.code === 'missing_topic_id') {
        showToast(t('topic_form.topic_created_but_lost'), 'warning');
        return;
      }
      showToast(err?.message || t('topic_form.create_error'), 'danger');
    } finally {
      setSubmitting(false);
    }
  }, [title, description, content, selectedCharacterId, pinFirstPost, guestNickname, submitting, user, characters, categoryId, hasPermission, PERMISSIONS, settings, navigate, showToast, t]);

  if (!category) {
    return (
      <div className="topic-form-loading">
        <div className="spinner" role="status" aria-label="Loading..." />
      </div>
    );
  }

  if (!hasPermission(PERMISSIONS.CREATE_TOPIC, { category })) {
    return (
      <div className="topic-form-access-denied">
        <h3 className="topic-form-access-denied__title">{t('topic_form.access_denied')}</h3>
        <p className="topic-form-access-denied__text">{t('topic_form.no_permission_desc')}</p>
        <button
          type="button"
          className="topic-btn topic-btn--accent"
          onClick={() => navigate('/')}
        >
          {t('topic_form.go_home')}
        </button>
      </div>
    );
  }

  return (
    <div className="topic-form-page">
      <ForumBreadcrumbs categoryId={categoryId} />
      <section className="topic-form-card">
        <header className="topic-form-header">
          <h2 className="topic-form-title">{t('forum.create_topic', 'Create Topic')}</h2>
        </header>
        <form className="topic-form" onSubmit={handleSubmit} noValidate>
          <div className="topic-form-field">
            <label className="topic-form-label" htmlFor="topicTitle">
              {t('topic_form.title_label')} <span className="topic-form-required">*</span>
            </label>
            <input
              type="text"
              id="topicTitle"
              className="topic-form-input"
              placeholder={t('topic_form.title_placeholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={LIMITS.title}
              required
              aria-invalid={!title && draftLoaded}
            />
            {!title && draftLoaded && (
              <div className="topic-form-feedback topic-form-feedback--error">
                {t('topic_form.title_required')}
              </div>
            )}
          </div>

          <div className="topic-form-field">
            <label className="topic-form-label" htmlFor="topicDescription">
              {t('topic_form.description_label')}
            </label>
            <input
              type="text"
              id="topicDescription"
              className="topic-form-input"
              placeholder={t('topic_form.description_placeholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={LIMITS.description}
            />
          </div>

          {canUseMasks && (
            <div className="topic-form-field">
              <label className="topic-form-label">
                {t('topic_form.mask_label')}
              </label>
              <MaskPicker
                value={selectedCharacterId}
                onChange={(charId) => {
                  const char = characters.find(c => c.id === charId);
                  setSelectedCharacterId(charId);
                  if (user && char) setLastSelectedMask(char.id);
                }}
                characters={characters}
                profile={profile}
                user={user}
                setLastSelectedMask={setLastSelectedMask}
                t={t}
              />
            </div>
          )}

          {!user && (
            <div className="topic-form-field">
              <label className="topic-form-label" htmlFor="guestNickname">
                {t('topic_form.nickname_label')} <span className="topic-form-required">*</span>
              </label>
              <input
                type="text"
                id="guestNickname"
                className="topic-form-input topic-form-input--auto"
                placeholder={t('topic_form.nickname_placeholder')}
                value={guestNickname}
                onChange={(e) => setGuestNickname(e.target.value)}
                required
              />
            </div>
          )}

          <div className="topic-form-field">
            <label className="topic-form-label" htmlFor="topicContent">
              {t('topic_form.content_label')}
            </label>
            <RichEditor
              id="topicContent"
              placeholder={t('topic_form.content_placeholder')}
              rows={6}
              minHeight="210px"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={LIMITS.content}
              disabled={submitting}
              showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
              isEdit={false}
              onSubmit={() => handleSubmit({ preventDefault: () => {} })}
            />
          </div>

          <div className="topic-form-field topic-form-field--checkbox">
            <input
              type="checkbox"
              id="pinFirstPost"
              className="topic-form-checkbox"
              checked={pinFirstPost}
              onChange={(e) => setPinFirstPost(e.target.checked)}
            />
            <label htmlFor="pinFirstPost" className="topic-form-checkbox-label">
              {t('forum.pin_first_post')}
            </label>
          </div>

          <div className="topic-form-actions">
            <button
              type="button"
              className="topic-btn topic-btn--secondary"
              disabled={submitting}
              onClick={() => navigate(`/category/${categoryId}`)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="topic-btn topic-btn--primary"
              disabled={submitting}
            >
              {submitting ? 'Creating...' : t('forum.create_topic')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};

export default TopicFormPage;
