import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Trash2, Move, Settings, PinOff, Pin, Lock, MessageSquare, Unlock } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { 
  fetchSecuredTopics, 
  batchUpdateTopics, 
  deleteTopics,
  moveTopics
} from '../api/forum';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumEmptyState from '../components/common/ForumEmptyState';
import ForumPagination from '../components/common/ForumPagination';
import LastPostInfo from '../components/common/LastPostInfo';
import AuthorMeta from '../components/common/AuthorMeta';
import TopicMiniPagination from '../components/common/TopicMiniPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import MoveTopicsModal from '../components/modals/MoveTopicsModal';
import ConfirmModal from '../components/common/ConfirmModal';
import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import { resolveField } from '../utils/text';
import { toMillis, unreadFloor } from '../utils/dates';
import { useToast } from '../contexts/ToastProvider';
import { usePageTitle } from '../contexts/TitleProvider';

const CategoryPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { user, profile, readMap, hasPermission, PERMISSIONS, categories, settings, scheduleForumStateRefresh, applyForumState } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [category, setCategory] = useState(null);
  const [pinnedTopics, setPinnedTopics] = useState([]);
  const [regularTopics, setRegularTopics] = useState([]);
  const [categoryRestricted, setCategoryRestricted] = useState(false);
  const [categoryRestrictedMessage, setCategoryRestrictedMessage] = useState('');
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
      // The server answers 200 with restricted: true when the caller's role
      // is not in the category's allowed_roles — render "access denied"
      // instead of an empty topic list.
      if (result.restricted) {
        setCategoryRestricted(true);
        setCategoryRestrictedMessage(result.message || '');
        setPinnedTopics([]);
        setRegularTopics([]);
        return;
      }
      setCategoryRestricted(false);
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
      showToast(t(pinned ? 'forum.topics_pinned' : 'forum.topics_unpinned'), 'success');
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };

  const handleBatchLock = async (locked) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await batchUpdateTopics(selectedTopicIds, { is_locked: locked }, user.uid);
      showToast(t(locked ? 'forum.topics_locked' : 'forum.topics_unlocked'), 'success');
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
      showToast(t('forum.topics_deleted'), 'success');
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
      showToast(t('forum.topics_moved'), 'success');
      setSelectedTopicIds([]);
      setIsManaging(false);
      loadTopics();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  };
  if (!loading && categoryRestricted) {
    return (
      <ErrorCard
        title={t('forum.access_denied')}
        message={categoryRestrictedMessage || undefined}
        error={null}
        hideTechnicalDetails
        onRetry={undefined}
      />
    );
  }

  return (
    <main id="forum-view" className="forum-view" data-forum-id={id}>
      <nav id="forum-breadcrumbs-top" aria-label="breadcrumb">
        <ForumBreadcrumbs
          items={[{ label: categoryTitle, active: true }]}
        />
      </nav>

      <header id="forum-view-header" className="category-header">
        <div className="category-header-heading">
          <h1 className="category-header-title">{categoryTitle}</h1>
          {!category ? (
            <Skeleton width={250} height="1rem" className="category-header-skeleton" />
          ) : resolveField(category.description, lang) && (
            <div className="category-header-description">
              {resolveField(category.description, lang)}
            </div>
          )}
        </div>
        <div className="category-header-actions">
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
                  {t(isManaging ? 'forum.done' : 'forum.manage')}
                </button>
              )}
              {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
                <Link
                  to={`/category/${id}/new-topic`}
                  className="forum-view-action-btn forum-view-action-btn--primary"
                >
                  {t('forum.create_topic')}
                </Link>
              )}
            </>
          )}
        </div>
      </header>

      <section id="forum-topic-list" className="forum-topic-list">
        {loading ? (
          <>
            <div className="category-subtitle">
              <span className="category-col--topic">{t('forum.topic')}</span>
              <span className="category-col--replies">{t('forum.replies')}</span>
              <span className="category-col--lastpost">{t('forum.last_post')}</span>
            </div>
            <div className="topic-list">
              {[...Array(5)].map((_, i) => (
                <article key={i} className="forum-item forum-item--topic forum-skeleton-row">
                  <div className="forum-info">
                    <h3 className="forum-title">
                      <Skeleton width="60%" height="1.1rem" className="forum-skeleton-gap" />
                      <Skeleton width="30%" height="0.8rem" />
                    </h3>
                  </div>
                  <div className="forum-posts" data-value={0}>
                    <Skeleton width={30} height="1rem" className="forum-skeleton-stat" />
                  </div>
                  <div className="forum-last-post last-post-strip" data-label={t('forum.last_post')}>
                    <Skeleton width="50%" height="0.9rem" className="forum-skeleton-gap" />
                    <Skeleton width="80%" height="0.7rem" />
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : loadError ? (
          <div className="forum-view-error">
            <ErrorCard
              title={t('forum.failed_load_topics')}
              error={loadError}
              onRetry={() => loadTopics(true)}
            />
          </div>
        ) : currentTopics.length === 0 ? (
          <>
            <ForumEmptyState
              className="forum-view-empty-state"
              icon={MessageSquare}
              title={t('forum.no_topics_yet')}
              description={t('forum.be_first')}
            />
            {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
              <div className="forum-view-empty-actions">
                <Link
                  to={`/category/${id}/new-topic`}
                  className="forum-view-action-btn forum-view-action-btn--primary"
                >
                  {t('forum.create_topic')}
                </Link>
              </div>
            )}
          </>
        ) : (
          <>
            <div className={`category-subtitle${isManaging ? ' has-check' : ''}`}>
              {isManaging && (
                <span className="category-subtitle-check">
                  <input
                    type="checkbox"
                    className="topic-select-input"
                    checked={selectedTopicIds.length === currentTopics.length && currentTopics.length > 0}
                    onChange={selectAll}
                  />
                </span>
              )}
              <span className="category-col--topic">{t('forum.topic')}</span>
              <span className="category-col--replies">{t('forum.replies')}</span>
              {/* <span className="category-col--views">{t('forum.views')}</span> */}
              <span className="category-col--lastpost">{t('forum.last_post')}</span>
            </div>
            <div className="topic-list">
              {currentTopics.map(topic => {
                const stateClasses = [
                  topic.is_pinned ? 'is-pinned' : '',
                  topic.is_locked ? 'is-locked' : '',
                  isManaging ? 'is-managing' : '',
                ].filter(Boolean).join(' ');

                // Same read-state predicate as MainPage.renderCategoryRows and
                // TopicRow: a topic is unread only if the server considers it
                // unread AND this device has not visited it since the last post.
                // `topic.unread` is stamped server-side by listForumIndexHandler
                // for category cards; listTopicsHandler (used here) does not
                // stamp it, so serverUnread is null and we fall back to the
                // localStorage read-map via isLocallyRead.
                const lastVisitRaw = readMap[topic.id];
                const lastVisitValue = lastVisitRaw?.timestamp || lastVisitRaw;
                const effectiveLastVisitMs = unreadFloor(lastVisitValue, profile?.created_at);
                const lastPostMs = toMillis(topic.last_post_at);
                const serverUnread = typeof topic.unread === 'boolean' ? topic.unread : null;
                const isLocallyRead = effectiveLastVisitMs >= lastPostMs;
                const isUnreadByServer = serverUnread !== null ? serverUnread : true;
                const hasUnread = !!user &&
                  profile?.role !== 'pending' &&
                  topic.last_post_author_ref?.user_id !== user?.uid &&
                  isUnreadByServer &&
                  !isLocallyRead;

                return (
                  <article
                    key={topic.id}
                    className={'forum-item forum-item--topic ' + stateClasses}
                    id={'topic-' + topic.id}
                    data-topic-id={topic.id}
                  >
                    {isManaging && (
                      <div className="topic-select">
                        <input
                          type="checkbox"
                          className="topic-select-input"
                          checked={selectedTopicIds.includes(topic.id)}
                          onChange={() => toggleSelect(topic.id)}
                        />
                      </div>
                    )}
                    <div className="forum-info">
                      <h3 className="forum-title">
                        {/* State icons sit INLINE with the title, bullet-like —
                            never on their own line above it. */}
                        {topic.is_pinned && (
                          <span className="topic-icon topic-pinned" aria-hidden="true">
                            <Pin size={14} fill="currentColor" />
                          </span>
                        )}
                        {topic.is_locked && (
                          <span className="topic-icon topic-locked" aria-hidden="true">
                            <Lock size={14} />
                          </span>
                        )}
                        <Link
                          to={'/topic/' + topic.id}
                          className="cat-link"
                          title={t('stats.to_first_post')}
                        >
                          {topic.title}
                        </Link>
                        <TopicMiniPagination topic={topic} />
                      </h3>
                      {topic.description && (
                        <div className="forum-description cat-desc">
                          {topic.description}
                        </div>
                      )}
                      {/* Creation meta (date · author) under the title,
                          same as the TopicRow reference render. */}
                      <div className="topic-author">
                        <AuthorMeta
                          date={topic.created_at}
                          author={topic.author}
                          showAvatar={false}
                          lang={lang}
                        />
                      </div>
                      <div className="forum-mobile-stats">
                        <span className="forum-mobile-stat">
                          <MessageSquare size={12} />
                          {' '}
                          {Math.max(0, (topic.posts_count || 1) - 1)}
                        </span>
                      </div>
                    </div>
                    <div className="forum-posts" data-value={topic.posts_count}>
                      {topic.posts_count || 0}
                    </div>
                    {/* Last post on the category page: timestamp + author only —
                        the topic title is already in the first column. */}
                    <div className="forum-last-post last-post-strip" data-label={t('forum.last_post')}>
                      <LastPostInfo
                        topicId={topic.id}
                        lastPostAt={topic.last_post_at}
                        author={topic.last_post_author_ref}
                        hasUnread={hasUnread}
                        lastReadOffset={
                          readMap[topic.id]?.offset ?? null
                        }
                        postsCount={topic.posts_count}
                        lang={lang}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
            {totalPages > 1 && (
              <nav id="forum-pagination-bottom" className="forum-view-pagination">
                <ForumPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                />
              </nav>
            )}
          </>
        )}
      </section>

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
            {t('forum.selected_count', { count: selectedTopicIds.length })}
          </div>
          <div className="management-toolbar-divider"></div>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--secondary" onClick={() => handleBatchPin(true)} disabled={selectedTopicIds.length === 0}>
            <Pin size={16} /> <span className="forum-view-action-label">{t('forum.pin')}</span>
          </button>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--secondary" onClick={() => handleBatchPin(false)} disabled={selectedTopicIds.length === 0}>
            <PinOff size={16} /> <span className="forum-view-action-label">{t('forum.unpin')}</span>
          </button>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--secondary" onClick={() => handleBatchLock(true)} disabled={selectedTopicIds.length === 0}>
            <Lock size={16} /> <span className="forum-view-action-label">{t('forum.lock')}</span>
          </button>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--secondary" onClick={() => handleBatchLock(false)} disabled={selectedTopicIds.length === 0}>
            <Unlock size={16} /> <span className="forum-view-action-label">{t('forum.unlock')}</span>
          </button>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--secondary" onClick={() => setShowMoveModal(true)} disabled={selectedTopicIds.length === 0}>
            <Move size={16} /> <span className="forum-view-action-label">{t('forum.move')}</span>
          </button>
          <button type="button" className="forum-view-action-btn forum-view-action-btn--danger" onClick={() => setShowDeleteModal(true)} disabled={selectedTopicIds.length === 0}>
            <Trash2 size={16} /> <span className="forum-view-action-label">{t('forum.delete')}</span>
          </button>
          {/* The instruction itself. It replaces the toolbar's role as the only
              thing on screen, and it disappears the moment the first topic is
              ticked, so the two states are never both talking at once. */}
          {selectedTopicIds.length === 0 && (
            <div className="management-toolbar-hint">
              {t('forum.tick_topics')}
            </div>
          )}
        </div>
      )}

      <ConfirmModal 
        show={showDeleteModal}
        onHide={() => setShowDeleteModal(false)}
        onConfirm={handleBatchDelete}
        title={t('forum.delete_topics_title')}
        message={t('forum.delete_topics_message', { count: selectedTopicIds.length })}
        confirmText={t('forum.delete_confirm')}
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
