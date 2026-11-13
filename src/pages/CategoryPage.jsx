import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Button, Badge, Row, Col, Form } from 'react-bootstrap';
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
import LastPostInfo from '../components/common/LastPostInfo';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
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
    <Container className="py-4 position-relative">
      <ForumBreadcrumbs 
        items={[{ label: categoryTitle, active: true }]} 
      />

      <div className="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center gap-3 mb-4">
        <div>
          <h2 className="mb-1">{categoryTitle}</h2>
          {!category ? (
            <Skeleton width={250} height="1rem" className="mt-2" />
          ) : resolveField(category.description, lang) && (
            <div className="text-muted mb-0">
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
                  {t(isManaging ? 'forum.done' : 'forum.manage')}
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
          <div className="category-content">
            <div className="category-head">
              <span className="category-col-topic">{t('forum.topic')}</span>
              <span className="category-col-replies">{t('forum.replies')}</span>
              <span className="category-col-lastpost">{t('forum.last_post')}</span>
            </div>
            <div className="category-topics-body">
              {[...Array(5)].map((_, i) => (
                <article key={i} className="forum-item forum-skeleton">
                  <div className="forum-info">
                    <h3 className="forum-title">
                      <Skeleton width="60%" height="1.1rem" className="mb-2" />
                      <Skeleton width="30%" height="0.8rem" />
                    </h3>
                  </div>
                  <div className="forum-topics" data-value={0}>
                    <Skeleton width={30} height="1rem" className="mx-auto" />
                  </div>
                  <div className="forum-posts" data-value={0}>
                    <Skeleton width={30} height="1rem" className="mx-auto" />
                  </div>
                  <div className="forum-last-post" data-label={t('forum.last_post')}>
                    <div className="last-post-content">
                      <Skeleton width="50%" height="0.9rem" className="mb-1" />
                      <Skeleton width="80%" height="0.7rem" />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : loadError ? (
          <div className="p-3">
            <ErrorCard
              title={t('forum.failed_load_topics')}
              error={loadError}
              onRetry={() => loadTopics(true)}
            />
          </div>
        ) : currentTopics.length === 0 ? (
          <div className="p-5 text-center">
            <div className="mb-3">💬</div>
            <h5 className="text-muted mb-2">
              {t('forum.no_topics_yet')}
            </h5>
            <p className="text-muted mb-4">
              {t('forum.be_first')}
            </p>
            {hasPermission(PERMISSIONS.CREATE_TOPIC, { category }) && (
              <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
                {t('forum.create_topic')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="category-content">
              <div className="category-head">
                <div className={`category-head-row${isManaging ? ' has-check' : ''}`}>
                  {isManaging && (
                    <span className="category-head-cell--check">
                      <Form.Check 
                        type="checkbox"
                        checked={selectedTopicIds.length === currentTopics.length && currentTopics.length > 0}
                        onChange={selectAll}
                      />
                    </span>
                  )}
                  <span className="category-col-cell">{t('forum.topic')}</span>
                  <span className="category-col-cell category-col-cell--replies">{t('forum.replies')}</span>
                  {/* <span className="category-col-cell text-center"">{t('forum.views')}</span> */}
                  <span className="category-col-cell">{t('forum.last_post')}</span>
                </div>
              </div>
              <div className="category-topics-body">
                {currentTopics.map(topic => {
                const stateClasses = [
                  topic.is_pinned ? 'is-pinned' : '',
                  topic.is_locked ? 'is-locked' : '',
                  isManaging ? 'is-managing' : '',
                ].filter(Boolean).join(' ');
                return (
                  <article
                    key={topic.id}
                    className={'forum-item ' + stateClasses}
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
                        <Link
                          to={'/topic/' + topic.id}
                          className="cat-link"
                          title={t('stats.to_first_post')}
                        >
                          {topic.title}
                        </Link>
                      </h3>
                      {topic.description && (
                        <div className="forum-description cat-desc">
                          {topic.description}
                        </div>
                      )}
                      <div className="forum-mobile-stats d-md-none">
                        <span className="forum-mobile-stat">
                          <MessageSquare size={12} />
                          {' '}
                          {Math.max(0, (topic.posts_count || 1) - 1)}
                        </span>
                      </div>
                    </div>
                    <div className="forum-topics" data-value={topic.topics_count || 1}>
                      {topic.topics_count || 1}
                    </div>
                    <div className="forum-posts" data-value={topic.posts_count}>
                      {topic.posts_count || 0}
                    </div>
                    <div className="forum-last-post" data-label={t('forum.last_post')}>
                      <div className="last-post-content">
                        <Link
                          to={'/topic/' + topic.id}
                          className="last-topic-link"
                          title={t('stats.to_first_post')}
                        >
                          {topic.title}
                        </Link>
                        <LastPostInfo
                          topicId={topic.id}
                          lastPostAt={topic.last_post_at}
                          author={topic.last_post_author_ref}
                          hasUnread={
                            !!user &&
                            profile?.role !== 'pending' &&
                            topic.last_post_author_ref?.user_id !== user?.uid
                          }
                          lastReadOffset={
                            readMap[topic.id]?.offset ?? null
                          }
                          postsCount={topic.posts_count}
                          lang={lang}
                        />
                      </div>
                    </div>
                  </article>
                );})}
              </div>
            </div>
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
            {t('forum.selected_count', { count: selectedTopicIds.length })}
          </div>
          <div className="vr d-none d-md-block mx-2"></div>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(true)} disabled={selectedTopicIds.length === 0}>
            <Pin size={16} /> <span className="d-none d-lg-inline">{t('forum.pin')}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(false)} disabled={selectedTopicIds.length === 0}>
            <PinOff size={16} /> <span className="d-none d-lg-inline">{t('forum.unpin')}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(true)} disabled={selectedTopicIds.length === 0}>
            <Lock size={16} /> <span className="d-none d-lg-inline">{t('forum.lock')}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(false)} disabled={selectedTopicIds.length === 0}>
            <Unlock size={16} /> <span className="d-none d-lg-inline">{t('forum.unlock')}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowMoveModal(true)} disabled={selectedTopicIds.length === 0}>
            <Move size={16} /> <span className="d-none d-lg-inline">{t('forum.move')}</span>
          </Button>
          <Button variant="danger" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowDeleteModal(true)} disabled={selectedTopicIds.length === 0}>
            <Trash2 size={16} /> <span className="d-none d-lg-inline">{t('forum.delete')}</span>
          </Button>
          {/* The instruction itself. It replaces the toolbar's role as the only
              thing on screen, and it disappears the moment the first topic is
              ticked, so the two states are never both talking at once. */}
          {selectedTopicIds.length === 0 && (
            <div className="small management-toolbar-hint">
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

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>


    </Container>
  );
};

export default CategoryPage;
