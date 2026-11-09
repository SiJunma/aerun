import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Trash2, Move, Settings, PinOff, Pin, Lock, Unlock } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import {
  fetchSecuredTopics,
  batchUpdateTopics,
  deleteTopics,
  moveTopics
} from '../api/forum';
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

  const isStaff = hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS) || hasPermission(PERMISSIONS.DELETE_OTHERS_POSTS) || hasPermission(PERMISSIONS.EDIT_OTHERS_TOPICS) || hasPermission(PERMISSIONS.DELETE_OTHERS_TOPICS);

  const loadTopics = useCallback(async (showLoading = true) => {
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
  }, [id, currentPage, ITEMS_PER_PAGE]);

  useEffect(() => {
    const found = categories.find(c => c.id === id);
    setCategory(found || null);
  }, [id, categories]);

  useEffect(() => {
    loadTopics(true);
  }, [id, currentPage, ITEMS_PER_PAGE, lang, setPageTitle, loadTopics]);

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
      <main id="forum-view" className="forum-view" data-forum-id={id}>
        <div className="forum-view-empty">
          <h3>{lang === 'ru' ? 'Категория не найдена или доступ запрещён' : 'Category not found or access denied'}</h3>
        </div>
      </main>
    );
  }

  const renderTopicListSkeleton = () => (
    <div className="topic-list">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="topic-item">
          <div className="topic-main">
            <Skeleton width="60%" height="1.1rem" className="topic-skeleton-title" />
            <Skeleton width="30%" height="0.8rem" />
          </div>
          <div className="topic-replies"><Skeleton width={30} height="1rem" /></div>
          <div className="topic-last-post">
            <Skeleton width="80%" height="0.8rem" className="topic-skeleton-last" />
            <Skeleton width="50%" height="0.7rem" />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <main
      id="forum-view"
      className={`forum-view forum-${id}`}
      data-forum-id={id}
    >
      <nav id="forum-breadcrumbs-top" aria-label="breadcrumb">
        <ForumBreadcrumbs
          items={[{ label: categoryTitle, active: true }]}
        />
      </nav>

      <header id="forum-view-header" className="forum-view-header">
        <div className="forum-view-heading">
          <h1 className="forum-view-title">{categoryTitle}</h1>
          {!category ? (
            <Skeleton width={250} height="1rem" className="forum-view-skeleton-desc" />
          ) : resolveField(category.description, lang) && (
            <p className="forum-view-description">
              {resolveField(category.description, lang)}
            </p>
          )}
        </div>
        <div id="forum-actions-top" className="forum-view-actions">
          {loading ? (
            <Skeleton width={120} height="2.5rem" />
          ) : (
            <>
              {isStaff && (
                <button
                  type="button"
                  className="forum-view-action-btn forum-view-action-btn--secondary"
                  onClick={() => {
                    setIsManaging(!isManaging);
                    setSelectedTopicIds([]);
                  }}
                >
                  <Settings size={18} />
                  {lang === 'ru' ? (isManaging ? 'Готово' : 'Управление') : (isManaging ? 'Done' : 'Manage')}
                </button>
              )}
              {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
                <Link to={`/category/${id}/new-topic`} className="forum-view-action-btn forum-view-action-btn--primary">
                  {t('forum.create_topic')}
                </Link>
              )}
            </>
          )}
        </div>
      </header>

      {totalPages > 1 && (
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          className="forum-pagination-view"
        />
      )}

      <section id="forum-topic-list" className="forum-topic-list">
        {loading ? (
          <div className="topic-list-head">
            <span className="topic-col-topic">{t('forum.topic')}</span>
            <span className="topic-col-replies">{t('forum.replies')}</span>
            <span className="topic-col-lastpost">{t('forum.last_post')}</span>
          </div>
        ) : null}
        {loading ? (
          renderTopicListSkeleton()
        ) : loadError ? (
          <div className="forum-view-empty">
            <ErrorCard
              title={lang === 'ru' ? 'Не удалось загрузить темы' : 'Failed to load topics'}
              error={loadError}
              onRetry={() => loadTopics(true)}
            />
          </div>
        ) : currentTopics.length === 0 ? (
          <div className="forum-view-empty">
            <div className="forum-view-empty-icon">💬</div>
            <h5>{lang === 'ru' ? 'Тем пока нет' : 'No topics yet'}</h5>
            <p className="forum-view-empty-note">
              {lang === 'ru'
                ? 'Будь первым — создай тему!'
                : 'Be the first to start a discussion!'}
            </p>
            {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
              <Link to={`/category/${id}/new-topic`} className="forum-view-action-btn forum-view-action-btn--primary">
                {t('forum.create_topic')}
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className={`topic-list-head ${isManaging ? 'is-managing' : ''}`}>
              {isManaging && (
                <span className="topic-col-select">
                  <input
                    type="checkbox"
                    className="topic-select-input"
                    checked={selectedTopicIds.length === currentTopics.length && currentTopics.length > 0}
                    onChange={selectAll}
                  />
                </span>
              )}
              <span className="topic-col-topic">{t('forum.topic')}</span>
              <span className="topic-col-replies">{t('forum.replies')}</span>
              <span className="topic-col-lastpost">{t('forum.last_post')}</span>
            </div>
            <div className="topic-list">
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
            </div>
          </>
        )}
      </section>

      {totalPages > 1 && (
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          className="forum-pagination-view"
        />
      )}


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
        <div className="management-toolbar">
          <div className="management-toolbar-count">
            {lang === 'ru'
              ? `Выбрано: ${selectedTopicIds.length}`
              : `Selected: ${selectedTopicIds.length}`}
          </div>
          <div className="management-toolbar-divider" aria-hidden="true"></div>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--secondary"
            onClick={() => handleBatchPin(true)}
            disabled={selectedTopicIds.length === 0}
          >
            <Pin size={16} /> <span>{lang === 'ru' ? 'Закрепить' : 'Pin'}</span>
          </button>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--secondary"
            onClick={() => handleBatchPin(false)}
            disabled={selectedTopicIds.length === 0}
          >
            <PinOff size={16} /> <span>{lang === 'ru' ? 'Открепить' : 'Unpin'}</span>
          </button>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--secondary"
            onClick={() => handleBatchLock(true)}
            disabled={selectedTopicIds.length === 0}
          >
            <Lock size={16} /> <span>{lang === 'ru' ? 'Закрыть' : 'Lock'}</span>
          </button>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--secondary"
            onClick={() => handleBatchLock(false)}
            disabled={selectedTopicIds.length === 0}
          >
            <Unlock size={16} /> <span>{lang === 'ru' ? 'Открыть' : 'Unlock'}</span>
          </button>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--secondary"
            onClick={() => setShowMoveModal(true)}
            disabled={selectedTopicIds.length === 0}
          >
            <Move size={16} /> <span>{lang === 'ru' ? 'Перенести' : 'Move'}</span>
          </button>
          <button
            type="button"
            className="forum-view-action-btn forum-view-action-btn--primary"
            onClick={() => setShowDeleteModal(true)}
            disabled={selectedTopicIds.length === 0}
          >
            <Trash2 size={16} /> <span>{lang === 'ru' ? 'Удалить' : 'Delete'}</span>
          </button>
          {selectedTopicIds.length === 0 && (
            <div className="management-toolbar-hint">
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

      <div className="forum-view-footer">
        <Link to="/" className="forum-view-back">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>

    </main>
  );
};

export default CategoryPage;
