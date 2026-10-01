import React, { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import { usePageTitle } from '../contexts/TitleProvider';

const TABS = { ALL: 'all', NEW: 'new_replies' };
const ITEMS_PER_PAGE = 20;

const NewRepliesPage = () => {
  const { t, lang } = useI18n();
  const {
    user, profile,
    latestTopics,
    markAllRead, isMarkingAllRead, unreadTopicsCount,
    hasPermission, PERMISSIONS, categories, readMap,
  } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') === TABS.NEW ? TABS.NEW : TABS.ALL;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  useEffect(() => {
    setPageTitle(t('stats.latest_replies', 'Активные темы'));
  }, [setPageTitle, t, lang]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title;
  };

  // All topics accessible to user — client-side filter from shared latestTopics
  const filteredTopics = useMemo(() => latestTopics.filter(topic => {
    const cat = categories.find(c => c.id === topic.category_id);
    return cat && hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  }), [latestTopics, categories, hasPermission]);

  // Unread topics — same algorithm as AuthProvider unreadTopicsCount
  const unreadTopics = useMemo(() => {
    if (!user) return [];

    const registrationMs = profile?.created_at?.toMillis?.()
      || (profile?.created_at ? new Date(profile.created_at).getTime() : 0);

    return filteredTopics.filter(topic => {
      if (topic.last_post_author_id === user.uid) return false;

      const entry = readMap[topic.id];
      const lastVisitValue = entry?.timestamp || entry;
      const lastVisitMs = lastVisitValue?.toMillis
        ? lastVisitValue.toMillis()
        : (typeof lastVisitValue === 'number' ? lastVisitValue : (lastVisitValue ? new Date(lastVisitValue).getTime() : 0));

      const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);

      const lastPostMs = topic.last_post_at?.toMillis?.()
        ?? (typeof topic.last_post_at === 'string'
          ? new Date(topic.last_post_at).getTime()
          : (typeof topic.last_post_at === 'number' ? topic.last_post_at : 0));

      return lastPostMs > effectiveLastVisitMs;
    });
  }, [filteredTopics, readMap, user, profile?.created_at]);

  const displayTopics = activeTab === TABS.NEW ? unreadTopics : filteredTopics;
  const totalPages = Math.ceil(displayTopics.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const currentTopics = displayTopics.slice(indexOfLastItem - ITEMS_PER_PAGE, indexOfLastItem);

  const switchTab = (tab) => {
    setSearchParams({ tab });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePageChange = (page) => {
    setSearchParams({ tab: activeTab, page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loading = latestTopics.length === 0 && categories.length === 0;

  return (
    <Container className="py-4">
      <ForumBreadcrumbs
        items={[{ label: t('stats.latest_replies', 'Активные темы'), active: true }]}
      />

      <div className="mb-3 d-flex justify-content-between align-items-end">
        <div>
          <h2 className="mb-0">{t('stats.latest_replies', 'Активные темы')}</h2>
        </div>
        {activeTab === TABS.NEW && user && (
          <button
            className="btn btn-outline-primary btn-sm rounded-pill px-3 d-flex align-items-center gap-2"
            onClick={() => markAllRead()}
            disabled={unreadTopics.length === 0 || unreadTopicsCount === 0 || isMarkingAllRead}
          >
            {isMarkingAllRead && (
              <div className="spinner-border spinner-border-sm" role="status">
                <span className="visually-hidden">Loading...</span>
              </div>
            )}
            {t('forum.mark_all_read')}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-3">
        <ul className="nav nav-tabs forum-tabs">
          <li className="nav-item">
            <button
              className={`nav-link${activeTab === TABS.ALL ? ' active' : ''}`}
              onClick={() => switchTab(TABS.ALL)}
              id="tab-all-active"
            >
              {t('stats.active_topics_tab', 'Все активные')}
            </button>
          </li>
          {user && (
            <li className="nav-item">
              <button
                className={`nav-link d-flex align-items-center gap-2${activeTab === TABS.NEW ? ' active' : ''}`}
                onClick={() => switchTab(TABS.NEW)}
                id="tab-new-replies"
              >
                {t('stats.new_replies_tab', 'Новые ответы')}
                {unreadTopicsCount > 0 && (
                <span className="badge rounded-pill badge-theme" style={{ fontSize: '0.7em' }}>
                    {unreadTopicsCount}
                  </span>
                )}
              </button>
            </li>
          )}
        </ul>
      </div>

      <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        ) : displayTopics.length === 0 ? (
          <div className="p-5 text-center text-muted">
            {activeTab === TABS.NEW
              ? t('stats.new_replies_tab_desc', 'Нет непрочитанных тем.')
              : t('stats.no_topics')}
          </div>
        ) : (
          <>
            <Table hover responsive className="mb-0 align-middle forum-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>{t('forum.topic')}</th>
                  <th className="d-none d-md-table-cell" style={{ width: '15%' }}>{t('forum.category')}</th>
                  <th className="text-center">{t('forum.replies')}</th>
                  <th>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {currentTopics.map(topic => (
                  <TopicRow
                    key={topic.id}
                    topic={topic}
                    user={user}
                    lang={lang}
                    showCategory={true}
                    showCategoryInColumn={true}
                    categoryName={getCategoryName(topic.category_id)}
                  />
                ))}
              </tbody>
            </Table>

            {totalPages > 1 && (
              <div className="p-3 border-top d-flex justify-content-center">
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

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>
    </Container>
  );
};

export default NewRepliesPage;
