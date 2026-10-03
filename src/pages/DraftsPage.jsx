import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Container, Form } from 'react-bootstrap';
import { AlertTriangle, Copy, FilePen, Send, Trash2 } from 'lucide-react';

import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { useToast } from '../contexts/ToastProvider';
import { usePageTitle } from '../contexts/TitleProvider';
import {
  listMyDrafts,
  listAllTopics,
  saveTopicDraft,
  deleteDraft,
  publishDraft,
} from '../api/forum';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumEmptyState from '../components/common/ForumEmptyState';
import ForumModal from '../components/common/ForumModal';
import ConfirmModal from '../components/common/ConfirmModal';
import Timestamp from '../components/common/Timestamp';
import BBCode from '../components/common/BBCode';
import ErrorCard from '../components/common/ErrorCard';
import { resolveField } from '../utils/text';

/**
 * The drafts page: every reply the author saved but never published.
 *
 * TWO SECTIONS, because they are not the same problem. A draft whose topic still
 * exists can be published, edited and opened in place. An ORPHAN — a draft whose
 * topic was deleted — cannot be published at all: publishDraftHandler resolves
 * the topic first and refuses a dead one. So the orphaned section deliberately
 * offers Copy and Delete and nothing else, rather than a Publish button that
 * would fail on click.
 *
 * The partition and the ordering both come from the server (an `orphan` flag per
 * item, orphans first). Re-sorting here would be a second ordering rule to keep
 * in step with that one.
 */
const DraftsPage = () => {
  const { t, lang } = useI18n();
  const { user, categories } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();
  const navigate = useNavigate();

  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Progress is tracked per draft, not as one global flag: a single `busyId`
  // would be enough today (one click at a time) but would silently disable the
  // other rows' buttons the moment that stopped being true.
  const [busyId, setBusyId] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // The copy flow: which orphan is being rescued, and where to.
  const [copying, setCopying] = useState(null);
  const [copyTopics, setCopyTopics] = useState([]);
  const [copyTopicsLoading, setCopyTopicsLoading] = useState(false);
  const [copyTargetId, setCopyTargetId] = useState('');

  useEffect(() => {
    setPageTitle(t('drafts.title', 'Драфты'));
  }, [setPageTitle, t, lang]);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDrafts(await listMyDrafts());
    } catch (err) {
      console.error('[DraftsPage] load error:', err);
      // A swallowed failure would render "No drafts yet" — the page would claim
      // the author has saved nothing, which is the opposite of what happened.
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setDrafts([]);
      setLoading(false);
      return;
    }
    loadDrafts();
  }, [user?.uid, loadDrafts]);

  const { orphans, live } = useMemo(
    () => ({
      orphans: drafts.filter(d => d.orphan),
      live: drafts.filter(d => !d.orphan),
    }),
    [drafts]
  );

  const categoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return resolveField(cat.name || cat.title, lang);
  };

  const handlePublish = async (draft) => {
    setBusyId(draft.id);
    try {
      const result = await publishDraft(draft.id);
      const newPostId = result?.postId || result?.id;
      showToast(t('drafts.published', 'Драфт опубликован'), 'success');
      // Straight to the published post, the same destination the composer uses
      // after publishing: landing on the topic top would hide the result of the
      // thing the user just did.
      navigate(newPostId ? `/topic/${draft.topic_id}?post=${newPostId}` : `/topic/${draft.topic_id}`);
    } catch (err) {
      console.error('[DraftsPage] publish error:', err);
      showToast(err?.message || t('forum.draft_publish_error', 'Ошибка публикации'), 'danger');
      loadDrafts();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    setBusyId(id);
    try {
      await deleteDraft(id);
      // Removed locally rather than re-read: the server's copy is gone, and
      // re-fetching would only confirm what the delete already established.
      setDrafts(prev => prev.filter(d => d.id !== id));
      showToast(t('drafts.deleted', 'Драфт удалён'), 'success');
    } catch (err) {
      console.error('[DraftsPage] delete error:', err);
      showToast(err?.message || t('common.error', 'Ошибка'), 'danger');
      loadDrafts();
    } finally {
      setBusyId(null);
    }
  };
const openCopy = async (draft) => {
    setCopying(draft);
    setCopyTargetId('');
    setCopyTopicsLoading(true);
    try {
      const all = await listAllTopics();
      // Only topics in categories this author can see. The endpoint answers with
      // every topic on the board, so this filter is what keeps the picker from
      // offering a destination the forum would refuse to open.
      const readable = all.filter(topic => {
        const cat = categories.find(c => c.id === topic.category_id);
        return !!cat;
      });
      setCopyTopics(readable);
    } catch (err) {
      console.error('[DraftsPage] copy topic load error:', err);
      showToast(err?.message || t('drafts.load_error', 'Не удалось загрузить драфты'), 'danger');
      setCopyTopics([]);
    } finally {
      setCopyTopicsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!copying || !copyTargetId) return;
    setBusyId(copying.id);
    try {
      // The mask travels with the copy: publishing promotes the row verbatim, so
      // a draft filed under the account would publish under the account, and the
      // identity the text was written in would be lost.
      await saveTopicDraft(
        copyTargetId,
        copying.content,
        copying.author_character_id || '',
        copying.rolls || null
      );
      setCopying(null);
      // Deliberately NOT deleting the original. Copy is the rescue path for text
      // that would otherwise be lost with a dead topic, and deleting the only
      // surviving copy as a side effect of saving it is not a trade anybody
      // asked for. Delete is one click away, and the toast says so.
      showToast(t('drafts.copy_done', 'Драфт сохранён в выбранную тему.'), 'success');
    } catch (err) {
      console.error('[DraftsPage] copy error:', err);
      showToast(err?.message || t('common.error', 'Ошибка'), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  const renderPreview = (draft) => {
    const content = (draft.content || '').trim();
    if (!content) {
      // An empty draft is legal — the server allows saving a placeholder — so
      // this is a real state, not a missing field.
      return (
        <span className="text-muted fst-italic small">
          {t('drafts.none_desc', 'Пустой драфт')}
        </span>
      );
    }
    return (
      <div className="post-preview text-muted small text-break">
        {/* No authorId: draftPayload does not carry one, and every draft on this
            page is the caller's own by construction (GET /me/drafts), so there is
            nothing for a per-author BBCode branch to resolve. */}
        <BBCode rolls={draft.rolls}>{content}</BBCode>
      </div>
    );
  };
const renderDraftCard = (draft, isOrphan) => {
    const busy = busyId === draft.id;
    return (
      <div key={draft.id} className="p-3 hover-bg-light transition-all border-bottom">
        <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
          <div className="min-w-0">
            {isOrphan ? (
              <span className="fw-bold d-block" style={{ fontSize: '1.05rem' }}>
                {t('drafts.orphan_badge', 'Тема удалена')}
              </span>
            ) : (
              // `?draft=1` asks TopicPage to open the editor on the draft it
              // loads, so "Edit" lands on the text rather than on a page the user
              // then has to find the draft card on.
              <Link
                to={`/topic/${draft.topic_id}?draft=1`}
                className="fw-bold text-decoration-none d-block"
                style={{ fontSize: '1.1rem', lineHeight: '1.25' }}
              >
                {draft.topic_title || '...'}
              </Link>
            )}
            <div className="d-flex align-items-center gap-2 mt-1 flex-wrap">
              {draft.category_id && (
                <Badge bg="secondary" className="opacity-75 fw-normal" style={{ fontSize: '0.7rem' }}>
                  {categoryName(draft.category_id)}
                </Badge>
              )}
              <span className="text-muted small">
                <Timestamp date={draft.updated_at || draft.created_at} />
              </span>
            </div>
          </div>

          <div className="d-flex gap-2 flex-shrink-0">
            {isOrphan ? (
              <>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 footer-link"
                  onClick={() => openCopy(draft)}
                  disabled={busy}
                >
                  <Copy size={12} className="me-1" />
                  {t('drafts.copy', 'Скопировать в тему')}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 footer-link"
                  onClick={() => setDeleting(draft)}
                  disabled={busy}
                >
                  <Trash2 size={12} className="me-1" />
                  {t('common.delete', 'Удалить')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 footer-link"
                  onClick={() => navigate(`/topic/${draft.topic_id}?draft=1`)}
                  disabled={busy}
                >
                  <FilePen size={12} className="me-1" />
                  {t('drafts.edit', 'Редактировать')}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 footer-link text-success fw-semibold"
                  onClick={() => handlePublish(draft)}
                  disabled={busy}
                >
                  <Send size={12} className="me-1" />
                  {busy ? t('forum.draft_publishing', 'Публикация...') : t('forum.draft_publish', 'Опубликовать')}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 footer-link"
                  onClick={() => setDeleting(draft)}
                  disabled={busy}
                >
                  <Trash2 size={12} className="me-1" />
                  {t('common.delete', 'Удалить')}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="line-clamp-4">{renderPreview(draft)}</div>
      </div>
    );
  };

  const renderSection = (titleKey, descKey, items, isOrphan) => {
    if (items.length === 0) return null;
    return (
      <Card className="shadow-sm border-0 bg-card mb-4 overflow-hidden">
        <Card.Header className="py-3">
          <div className="d-flex align-items-center gap-2">
            {isOrphan && <AlertTriangle size={16} className="text-warning flex-shrink-0" />}
            <h5 className="mb-0">{t(titleKey)}</h5>
            <Badge bg="secondary" className="opacity-75">{items.length}</Badge>
          </div>
          <p className="text-muted small mb-0 mt-1">{t(descKey)}</p>
        </Card.Header>
        <Card.Body className="p-0">
          <div className="posts-history-list">
            {items.map(d => renderDraftCard(d, isOrphan))}
          </div>
        </Card.Body>
      </Card>
    );
  };
return (
    <Container className="py-4">
      <ForumBreadcrumbs items={[{ label: t('drafts.title', 'Драфты'), active: true }]} />

      <div className="mb-4">
        <h2>{t('drafts.title', 'Драфты')}</h2>
        <p className="text-muted small mb-0">
          {t('drafts.subtitle', 'Ответы, которые вы сохранили, но ещё не опубликовали.')}
        </p>
      </div>

      {loadError ? (
        // `error`, not `message`: the card renders its own copy from the status
        // code and only shows the technical block when it is handed the error
        // object. Passing a bare string would drop the diagnosis the admin needs.
        <ErrorCard error={loadError} onRetry={loadDrafts} />
      ) : loading ? (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading', 'Загрузка...')}
          </div>
        </Card>
      ) : drafts.length === 0 ? (
        <ForumEmptyState
          className="mb-4"
          icon={FilePen}
          title={t('drafts.none_title', 'Драфтов пока нет')}
          description={t('drafts.none_desc', 'Всё, что вы сохраните как драфт, собирается здесь до публикации.')}
        />
      ) : (
        <>
          {renderSection('drafts.orphans_title', 'drafts.orphans_desc', orphans, true)}
          {renderSection('drafts.in_progress_title', 'drafts.subtitle', live, false)}
        </>
      )}

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          {t('common.back_to_main', 'На главную')}
        </Link>
      </div>

      <ConfirmModal
        show={!!deleting}
        onHide={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={t('drafts.delete_title', 'Удалить этот драфт?')}
        message={t('drafts.delete_message', 'Сохранённый текст будет удалён. Отменить это нельзя.')}
        confirmText={t('common.delete', 'Удалить')}
      />

      <ForumModal
        show={!!copying}
        onHide={() => setCopying(null)}
        title={t('drafts.copy_title', 'Скопировать драфт в тему')}
        footer={
          <>
            <Button
              variant="link"
              className="text-decoration-none text-muted fw-bold me-2"
              onClick={() => setCopying(null)}
            >
              {t('common.cancel', 'Отмена')}
            </Button>
            <Button
              variant="primary"
              className="px-4 fw-bold shadow-sm"
              onClick={handleCopy}
              disabled={!copyTargetId || !!busyId}
            >
              {t('drafts.copy', 'Скопировать в тему')}
            </Button>
          </>
        }
      >
        <p className="text-muted small">
          {t('drafts.copy_desc', 'Выберите тему, в которую сохранить этот драфт.')}
        </p>

        {copyTopicsLoading ? (
          <div className="text-center text-muted py-3">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading', 'Загрузка...')}
          </div>
        ) : copyTopics.length === 0 ? (
          <div className="text-muted small py-2">
            {t('drafts.copy_no_topics', 'Нет доступных тем для копирования.')}
          </div>
        ) : (
          <Form.Group>
            <Form.Label className="fw-bold small">{t('drafts.copy_pick_topic', 'Тема')}</Form.Label>
            <Form.Select
              value={copyTargetId}
              onChange={e => setCopyTargetId(e.target.value)}
              aria-label={t('drafts.copy_pick_topic', 'Тема')}
            >
              <option value="">—</option>
              {copyTopics.map(topic => (
                <option key={topic.id} value={topic.id}>
                  {categoryName(topic.category_id) ? `[${categoryName(topic.category_id)}] ` : ''}
                  {topic.title}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        )}
      </ForumModal>
    </Container>
  );
};

export default DraftsPage;


