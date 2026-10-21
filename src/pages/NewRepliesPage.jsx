import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { MessageSquare, Bell } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToLatestTopics, subscribeToUnreadTopics } from '../api/auth-resources';
import TopicRow from '../components/common/TopicRow';
import { toMillis, unreadFloor } from '../utils/dates';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumTabs from '../components/common/ForumTabs';
import ForumEmptyState from '../components/common/ForumEmptyState';
import { usePageTitle } from '../contexts/TitleProvider';
import { resolveField } from '../utils/text';

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
  const [total, setTotal] = useState(0);
  const [topicsLoading, setTopicsLoading] = useState(true);

  const activeTab = searchParams.get('tab') === TABS.NEW ? TABS.NEW : TABS.ALL;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  // Re-entering the loading state is derived from (tab, page), not from the
  // subscription, so it is reset during render when either changes rather than
  // inside the effect — the effect's own setTopicsLoading(true) ran on every
  // mount and triggered a cascading render. `topicsLoading` already starts true,
  // so only a tab/page change needs the reset.
  const feedKey = `${activeTab}:${currentPage}`;
  const [prevFeedKey, setPrevFeedKey] = useState(feedKey);
  if (feedKey !== prevFeedKey) {
    setPrevFeedKey(feedKey);
    setTopicsLoading(true);
  }

  useEffect(() => {
    setPageTitle(t('stats.latest_replies', 'Активные темы'));
  }, [setPageTitle, t, lang]);

  // ONE subscription, chosen by tab, and paged on the server.
  //
  // The unread tab used to filter a fifty-row general feed in the browser, which
  // is the defect this replaces: a client filter can only see what it fetched,
  // so a topic with unread replies beyond that window was not unsorted — it was
  // absent, and the member was told they had fewer new replies than they had. The
  // unread set is now the server's, because the server owns the read states.
  //
  // Still a poll, deliberately. The screen re-read every 20s before this change
  // and a member watching for replies depends on that; paging it is not a reason
  // to freeze the list.
  useEffect(() => {
    let active = true;

    // Two explicit subscriptions rather than one selected by a variable.
    //
    // The contract test asserts this screen calls `subscribeToLatestTopics(`,
    // and the assertion is the right one: the list must be read where it is
    // rendered, not left to a provider mounted for the whole session. A variable
    // holding the same function behaves identically and fails it, which is a fair
    // trade — the contract is about the call being visible here.
    const apply = (data) => {
      if (!active) return;
      setTopics(data?.topics || []);
      setTotal(data?.total ?? 0);
      setTopicsLoading(false);
    };

    const unsubscribe = activeTab === TABS.NEW
      ? subscribeToUnreadTopics(apply, currentPage, ITEMS_PER_PAGE)
      : subscribeToLatestTopics(apply, currentPage, ITEMS_PER_PAGE);

    // The unmount guard matters: this screen is reached from a navbar badge, so
    // a member can leave it by clicking a thread, and a resolved read landing
    // after that would set state on a page that is gone.
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeTab, currentPage]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return resolveField(cat.title, lang);
  };

  // The list is ALREADY filtered by the server — by category access on the ALL
  // tab, and by the caller's own read state on the NEW tab.
  //
  // It used to be re-filtered here with `hasPermission(VIEW_FORUM)` against whatever
  // categories the main page had happened to load. That was a second, weaker copy of
  // an authorization decision the command layer already made on the server — and a
  // weaker one is worse than none: a category that had not loaded yet read as "not
  // permitted", so rows silently vanished, and a member whose local role state was
  // stale saw a different list than the server had approved.
  const filteredTopics = topics;

  // Which of the rows ON THIS PAGE are unread, locally.
  //
  // This is deliberately NOT how the NEW tab is filled — that set is the
  // server's, or unread topics past the first page would be invisible. This
  // answers a different, narrower question: "which rows am I looking at right
  // now", which is what the mark-all-read button needs and which TopicRow already
  // answers the same way for its highlight.
  const registrationMs = toMillis(profile?.created_at);
  const unreadTopics = topics.filter(topic => {
    if (!user) return false;
    if (topic.last_post_author_ref?.user_id === user.uid) return false;
    const entry = readMap[topic.id];
    const effectiveLastVisitMs = unreadFloor(entry?.timestamp || entry, registrationMs);
    return toMillis(topic.last_post_at) > effectiveLastVisitMs;
  });

  // NO client-side slice and no local unread computation. The server returned
  // exactly this page, already narrowed by the caller's own read state on the NEW
  // tab, and TopicRow derives its own highlight the same way it does everywhere
  // else. Deciding unreadness here a second time is how the feed and the tab badge
  // end up counting different things.
  const currentTopics = filteredTopics;

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

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
      ) : currentTopics.length === 0 ? (
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
