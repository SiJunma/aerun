import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { MessageSquare, Bell } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToLatestTopics } from '../api/auth-resources';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumTabs from '../components/common/ForumTabs';
import ForumEmptyState from '../components/common/ForumEmptyState';
import { usePageTitle } from '../contexts/TitleProvider';

const TABS = { ALL: 'all', NEW: 'new_replies' };
const ITEMS_PER_PAGE = 20;

const NewRepliesPage = () => {
  const { t, lang } = useI18n();
  const {
    user, profile,
    markAllRead, isMarkingAllRead, unreadTopicsCount,
    categories, readMap,
  } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();

  // The list is read HERE, not from the main-page projection.
  //
  // It used to arrive in AuthProvider's `latestTopics`, which the main page fetched
  // on every identity change — so every member, on every page, paid for fifty
  // topic records to render a navbar integer, and this screen paginated a fixed
  // fifty in memory instead of asking for a page. The only screen that renders
  // topic rows now reads them, and only while it is mounted.
  const [topics, setTopics] = useState([]);
  const [topicsLoading, setTopicsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setTopicsLoading(true);
    const unsubscribe = subscribeToLatestTopics((rows) => {
      if (!active) return;
      setTopics(rows);
      setTopicsLoading(false);
    });

    // Unsubscribing matters here for the first time: this list used to be owned by
    // AuthProvider, which is mounted for the whole session, so its poll outlived
    // every reader of it. Mounted here, the loop starts when the page opens and
    // stops when it closes — and the poll is shared by name, so /active-topics
    // still reads the same resource with no second request.
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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

  // The list is ALREADY filtered by the server.
  //
  // It used to be re-filtered here with `hasPermission(VIEW_FORUM)` against whatever
  // categories the main page had happened to load. That was a second, weaker copy of
  // an authorization decision the command layer already made on the server — and a
  // weaker one is worse than none: a category that had not loaded yet read as "not
  // permitted", so rows silently vanished, and a member whose local role state was
  // stale saw a different list than the server had approved. The read map below is
  // still local, because "which of THESE rows have I read" is a rendering question;
  // "which rows exist for me" is not.
  const filteredTopics = topics;

  // Unread rows — the per-row highlight. The NUMBER in the navbar and tab title is
  // server state (`unread_topics`), because it has to agree across devices and
  // cannot be capped by a page size; this list is scoped to the page it is on, which
  // is a different question and can answer it from what is on screen.
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

  // This screen's own loading state, not the main page's. It used to be derived
  // from `latestTopics.length === 0 && categories.length === 0`, which reported
  // "loading" forever on a genuinely empty forum — the two states are
  // indistinguishable from an empty array, which is the same class of bug as the
  // optional-chaining ones in check-forum-read-contract.
  const loading = topicsLoading;

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
            // The ids of the rows the member can actually SEE, not a page size and
            // not "whatever was last fetched". The server marks what it is given and
            // refuses anything in a category this member may not read, so handing it
            // a list that includes hidden rows would make the whole call fail — and
            // skipping them silently is the behaviour this replaced.
            onClick={() => markAllRead(unreadTopics.map(t => t.id))}
            // Gated on the rows on screen, not on the badge number. The badge counts
            // the WHOLE board while this list is one page of it, so requiring both to
            // be non-zero is what made this button permanently disabled whenever the
            // two disagreed — which they always did, since the badge counts topics
            // this member cannot see on this page.
            disabled={unreadTopics.length === 0 || isMarkingAllRead}
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
      <ForumTabs
        activeId={activeTab}
        onChange={switchTab}
        tabs={[
          {
            id: TABS.ALL,
            label: t('stats.active_topics_tab', 'Все активные'),
            icon: <MessageSquare size={16} />
          },
          ...(user
            ? [{
                id: TABS.NEW,
                label: t('stats.new_replies_tab', 'Новые ответы'),
                icon: <Bell size={16} />,
                badge: unreadTopicsCount
              }]
            : [])
        ]}
      />

      {loading ? (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        </Card>
      ) : displayTopics.length === 0 ? (
        /* The empty list replaces the table card entirely: a table header over
         * zero rows reads as a populated list whose data failed to load. */
        <ForumEmptyState
          className="mb-4"
          icon={activeTab === TABS.NEW ? Bell : MessageSquare}
          title={
            activeTab === TABS.NEW
              ? t('stats.no_new_replies', 'Непрочитанных тем нет')
              : t('stats.no_topics', 'Тем пока нет')
          }
          description={
            activeTab === TABS.NEW
              ? t('stats.no_new_replies_desc', 'Вы всё прочитали.')
              : t('stats.no_topics_desc', 'Как только появится тема, она отобразится здесь.')
          }
        />
      ) : (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
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
        </Card>
      )}

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>
    </Container>
  );
};

export default NewRepliesPage;
