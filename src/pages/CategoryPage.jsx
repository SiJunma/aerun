import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table, Button, Badge, Row, Col, Form } from 'react-bootstrap';
import { Trash2, Move, Settings, PinOff, Pin, Lock, PlusCircle, Search, MessageSquare, Clock, Filter, FolderInput, Unlock, CheckCircle } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { 
  fetchSecuredTopics, 
  batchUpdateTopics, 
  deleteTopics,
  moveTopics
} from '../api/forum';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import TopicRow from '../components/common/TopicRow';
import MoveTopicsModal from '../components/modals/MoveTopicsModal';
import ConfirmModal from '../components/common/ConfirmModal';
import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import { resolveField } from '../utils/text';
import { useToast } from '../contexts/ToastProvider';
import { usePageTitle } from '../contexts/TitleProvider';

const CategoryPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { user, hasPermission, PERMISSIONS, categories, settings, scheduleForumStateRefresh, applyForumState } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [category, setCategory] = useState(null);
  const [pinnedTopics, setPinnedTopics] = useState([]);
  const [regularTopics, setRegularTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Management State
  const [isManaging, setIsManaging] = useState(false);
  const [selectedTopicIds, setSelectedTopicIds] = useState([]);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const ITEMS_PER_PAGE = settings?.topicsPerPage || 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  const isStaff = hasPermission(PERMISSIONS.MODERATE_CONTENT);

  const loadTopics = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchSecuredTopics(id, currentPage, ITEMS_PER_PAGE);
      setPinnedTopics(result.pinned || []);
      setRegularTopics(result.topics || []);
    } catch (err) {
      console.error('[CategoryPage loadTopics err]', err);
      setLoadError(err);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    const found = categories.find(c => c.id === id);
    setCategory(found || null);
  }, [id, categories]);

  useEffect(() => {
    loadTopics(true);
  }, [id, currentPage, ITEMS_PER_PAGE, lang, setPageTitle]);

  useEffect(() => {
    if (category) {
      setPageTitle(resolveField(category.title, lang));
    } else {
      setPageTitle('');
    }
  }, [category, lang, setPageTitle]);

  const categoryTitle = category ? resolveField(category.title, lang) : <Skeleton width={150} height="1.5rem" />;

  // Pagination logic
  const totalPages = Math.ceil((category?.topics_count || 0) / ITEMS_PER_PAGE) || 1;
  const currentTopics = [...pinnedTopics, ...regularTopics];

  const handlePageChange = (page) => {
    setSearchParams({ page });
  };

  // Management Handlers
  const toggleSelect = (topicId) => {
    setSelectedTopicIds(prev => 
      prev.includes(topicId) ? prev.filter(id => id !== topicId) : [...prev, topicId]
    );
  };

  const selectAll = () => {
    if (selectedTopicIds.length === currentTopics.length) {
      setSelectedTopicIds([]);
    } else {
      setSelectedTopicIds(currentTopics.map(t => t.id));
    }
  };

  const handleBatchPin = async (pinned) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await batchUpdateTopics(selectedTopicIds, { is_pinned: pinned }, user.uid);
      showToast(lang === 'ru' 
          ? (pinned ? 'Темы закреплены' : 'Темы откреплены') 
          : (pinned ? 'Topics pinned' : 'Topics unpinned'), 'success');
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };

  const handleBatchLock = async (locked) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await batchUpdateTopics(selectedTopicIds, { is_locked: locked }, user.uid);
      showToast(lang === 'ru' 
          ? (locked ? 'Темы закрыты' : 'Темы открыты') 
          : (locked ? 'Topics locked' : 'Topics unlocked'), 'success');
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTopicIds.length === 0) return;
    try {
      const deleteResult = await deleteTopics(selectedTopicIds, user.uid);
      if (deleteResult?.forum) {
        applyForumState(deleteResult.forum);
      } else {
        scheduleForumStateRefresh();
      }
      showToast(lang === 'ru' ? 'Темы удалены' : 'Topics deleted', 'success');
      setSelectedTopicIds([]);
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };

  const handleConfirmMove = async (targetCatId) => {
    if (selectedTopicIds.length === 0) return;
    try {
      const moveResult = await moveTopics(selectedTopicIds, targetCatId, user.uid);
      if (moveResult?.forum) {
        applyForumState(moveResult.forum);
      } else {
        scheduleForumStateRefresh();
      }
      showToast(lang === 'ru' ? 'Темы перенесены' : 'Topics moved', 'success');
      setSelectedTopicIds([]);
      setIsManaging(false);
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };
  if (!loading && category && !hasPermission(PERMISSIONS.VIEW_FORUM, { category })) {
    return (
      <Container className="py-5 text-center">
        <h3 className="text-muted">{lang === 'ru' ? 'Категория не найдена или доступ запрещён' : 'Category not found or access denied'}</h3>
      </Container>
    );
  }

  return (
    <Container className="py-4 position-relative">
      <ForumBreadcrumbs 
        items={[{ label: categoryTitle, active: true }]} 
      />

      <div className="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center gap-3 mb-4">
        <div>
          <h2 className="mb-1">{categoryTitle}</h2>
          {!category ? (
            <Skeleton width={250} height="1rem" className="mt-2" />
          ) : category.description && (
            <div className="text-muted mb-0" style={{ lineHeight: 1.2, fontSize: '0.875rem' }}>
              {resolveField(category.description, lang)}
            </div>
          )}
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {loading ? (
             <Skeleton width={120} height="2.5rem" />
          ) : (
            <>
              {isStaff && (
                <Button 
                  variant={isManaging ? "secondary" : "outline-primary"}
                  onClick={() => {
                    setIsManaging(!isManaging);
                    setSelectedTopicIds([]);
                  }}
                  className="d-flex align-items-center gap-2"
                >
                  <Settings size={18} />
                  {lang === 'ru' ? (isManaging ? 'Готово' : 'Управление') : (isManaging ? 'Done' : 'Manage')}
                </Button>
              )}
              {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
                <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
                  {t('forum.create_topic')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Card className={`mb-4 overflow-hidden forum-group-card ${!loading && currentTopics.length === 0 ? '' : 'border-0 bg-transparent shadow-none'}`}>
        {loading ? (
          <div className="p-0">
            <Table hover responsive className="mb-0 align-middle forum-table">
              <thead>
                <tr>
                  <th style={{ width: '50%' }}>{t('forum.topic')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.replies')}</th>
                  <th style={{ minWidth: 180 }}>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {[...Array(5)].map((_, i) => (
                  <tr key={i}>
                    <td className="py-3 px-4">
                      <div className="d-flex align-items-center gap-3">
                        <Skeleton variant="avatar" width={40} height={40} className="rounded-circle" />
                        <div className="flex-grow-1">
                          <Skeleton width="60%" height="1.1rem" className="mb-2" />
                          <Skeleton width="30%" height="0.8rem" />
                        </div>
                      </div>
                    </td>
                    <td className="text-center p-3">
                      <Skeleton width={30} height="1rem" className="mx-auto" />
                    </td>
                    <td className="p-3">
                      <div className="d-flex align-items-center gap-2">
                        <Skeleton variant="avatar" width={32} height={32} className="rounded-circle" />
                        <div className="flex-grow-1">
                          <Skeleton width="80%" height="0.8rem" className="mb-1" />
                          <Skeleton width="50%" height="0.7rem" />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : loadError ? (
          <div className="p-3">
            <ErrorCard
              title={lang === 'ru' ? 'Не удалось загрузить темы' : 'Failed to load topics'}
              error={loadError}
              onRetry={() => loadTopics(true)}
            />
          </div>
        ) : currentTopics.length === 0 ? (
          <div className="p-5 text-center">
            <div className="mb-3" style={{ fontSize: '3rem', opacity: 0.3 }}>💬</div>
            <h5 className="text-muted mb-2">
              {lang === 'ru' ? 'Тем пока нет' : 'No topics yet'}
            </h5>
            <p className="text-muted mb-4" style={{ fontSize: '0.875rem' }}>
              {lang === 'ru'
                ? 'Будь первым — создай тему!'
                : 'Be the first to start a discussion!'}
            </p>
            {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
              <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
                {t('forum.create_topic')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <Table hover responsive className="mb-0 align-middle forum-table">
              <thead>
                <tr>
                  {isManaging && (
                    <th style={{ width: '40px' }}>
                      <Form.Check 
                        type="checkbox"
                        checked={selectedTopicIds.length === currentTopics.length && currentTopics.length > 0}
                        onChange={selectAll}
                      />
                    </th>
                  )}
                  <th style={{ width: '50%' }}>{t('forum.topic')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.replies')}</th>
                  {/* <th className="text-center">{t('forum.views')}</th> */}
                  <th style={{ minWidth: 180 }}>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {currentTopics.map(topic => (
                  <TopicRow 
                    key={topic.id}
                    topic={topic}
                    user={user}
                    lang={lang}
                    isManaging={isManaging}
                    isSelected={selectedTopicIds.includes(topic.id)}
                    onSelect={toggleSelect}
                  />
                ))}
              </tbody>
            </Table>
            {totalPages > 1 && (
              <div className="p-3 d-flex justify-content-center border-top">
                <ForumPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                />
              </div>
            )}
          </>
        )}
      </Card>

      {/* Management Toolbar */}
      {/* The toolbar is shown for the WHOLE manage mode, not only once topics
          are ticked. It used to be gated on `selectedTopicIds.length > 0`, so
          pressing "Manage" changed only the button label to "Done" and left the
          page silent about the next step — the action bar is fixed to the BOTTOM
          of the viewport, far from the header button that was just pressed, so
          there was nothing on screen hinting that topics had to be selected
          first. The bar now states the instruction itself, and its buttons are
          disabled until there is something to act on. */}
      {isManaging && (
        <div className="management-toolbar user-select-none">
          <div className="me-2 small fw-bold">
            {lang === 'ru'
              ? `Выбрано: ${selectedTopicIds.length}`
              : `Selected: ${selectedTopicIds.length}`}
          </div>
          <div className="vr d-none d-md-block mx-2"></div>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(true)} disabled={selectedTopicIds.length === 0}>
            <Pin size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Закрепить' : 'Pin'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(false)} disabled={selectedTopicIds.length === 0}>
            <PinOff size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Открепить' : 'Unpin'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(true)} disabled={selectedTopicIds.length === 0}>
            <Lock size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Закрыть' : 'Lock'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(false)} disabled={selectedTopicIds.length === 0}>
            <Unlock size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Открыть' : 'Unlock'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowMoveModal(true)} disabled={selectedTopicIds.length === 0}>
            <Move size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Перенести' : 'Move'}</span>
          </Button>
          <Button variant="danger" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowDeleteModal(true)} disabled={selectedTopicIds.length === 0}>
            <Trash2 size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Удалить' : 'Delete'}</span>
          </Button>
          {/* The instruction itself. It replaces the toolbar's role as the only
              thing on screen, and it disappears the moment the first topic is
              ticked, so the two states are never both talking at once. */}
          {selectedTopicIds.length === 0 && (
            <div className="small management-toolbar-hint">
              {lang === 'ru'
                ? 'Отметьте темы галочками слева, чтобы применить действия'
                : 'Tick the topics on the left to apply actions'}
            </div>
          )}
        </div>
      )}

      <ConfirmModal 
        show={showDeleteModal}
        onHide={() => setShowDeleteModal(false)}
        onConfirm={handleBatchDelete}
        title={lang === 'ru' ? 'Удалить темы?' : 'Delete topics?'}
        message={lang === 'ru' 
          ? `Вы уверены, что хотите навсегда удалить выбранные темы (${selectedTopicIds.length})? Это действие нельзя отменить.` 
          : `Are you sure you want to permanently delete the selected topics (${selectedTopicIds.length})? This action cannot be undone.`
        }
        confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
      />

      <MoveTopicsModal 
        show={showMoveModal}
        onHide={() => setShowMoveModal(false)}
        onConfirm={handleConfirmMove}
        topicCount={selectedTopicIds.length}
        excludeCategoryId={id}
      />

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>


    </Container>
  );
};

export default CategoryPage;
