import React, { useState, useEffect } from 'react';
import { Card, Table, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { Folder, MessageSquare, FileText } from 'lucide-react';
import LastPostInfo from '../components/common/LastPostInfo';
import ForumStats from '../components/layout/ForumStats';
import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import ForumEmptyState from '../components/common/ForumEmptyState';
import { resolveField } from '../utils/text';
import { toMillis, unreadFloor } from '../utils/dates';
import { usePageTitle } from '../contexts/TitleProvider';

const MainPage = () => {
  const { t, lang } = useI18n();
  // Categories AND groups come from ONE read, which AuthProvider already makes
  // (forum-index) and re-makes whenever the identity changes.
  //
  // This page used to ALSO call subscribeToForumIndex, which meant opening the
  // forum issued two reads of the same category rows on two unrelated clocks,
  // and the index rendered whichever pairing of (categories, groups) happened to
  // be on screen — a category filed under a group the other read had not returned
  // yet landed in no section at all, silently.
  //
  // The index cannot paint from half of that pair, so it is now delivered half
  // as often: once, by the provider that already has to re-read it on sign-in,
  // sign-out and role change. `categories` is filtered by canViewCategory on the
  // SERVER, so there is no client-side role check to repeat here.
  const { user, profile, categories, categoryGroups, readMap, forumStateLoading, forumStateError, refreshForumState } = useAuth();
  const [timeoutExpired, setTimeoutExpired] = useState(false);
  const { setPageTitle } = usePageTitle();

  const groups = categoryGroups;

  useEffect(() => {
    setPageTitle('');
  }, [setPageTitle]);

  // While a logged-in user's profile is still loading from Firestore, treat as loading
  // to prevent a flash of content with wrong permissions (profile=null → role='player', then
  // flips to 'pending' once profile arrives and categories may disappear).
  const profileLoading = !!user && profile === null;
  // Categories are supplied only by getSecuredMainPageData. An empty list is a
  // valid server result, so use its explicit loading state rather than length.
  const catsLoading = forumStateLoading;

  useEffect(() => {
    if (catsLoading || profileLoading) {
      const timer = setTimeout(() => {
        setTimeoutExpired(true);
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [catsLoading, profileLoading]);

  return (
    <div className="pt-5 pb-4">

      {(catsLoading || profileLoading) ? (
        timeoutExpired ? (
          <ErrorCard
            isNetworkError={true}
            title={lang === 'ru' ? 'Не удалось загрузить разделы форума' : 'Failed to load forum categories'}
            message={lang === 'ru'
              ? 'Сервер не ответил вовремя. Пожалуйста, проверьте подключение к интернету или попробуйте обновить страницу.'
              : 'The server did not respond in time. Please check your internet connection or try refreshing the page.'
            }
            error={forumStateError}
            onRetry={() => refreshForumState(true, true)}
          />
        ) : (
        <Card className="shadow-sm border-0">
          <div className="p-0">
            <Table responsive className="mb-0 align-middle">
              <thead>
                <tr>
                  <th style={{ minWidth: 260 }}>{t('forum.category')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.topics')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.posts')}</th>
                  <th style={{ minWidth: 180 }}>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {[...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td className="py-3 px-3">
                      <Skeleton width="50%" height="1.4rem" className="mb-2" />
                      <Skeleton width="80%" height="0.9rem" />
                    </td>
                    <td className="text-center">
                      <Skeleton width={30} height="1rem" className="mx-auto" />
                    </td>
                    <td className="text-center">
                      <Skeleton width={30} height="1rem" className="mx-auto" />
                    </td>
                    <td>
                      <div className="d-flex align-items-center gap-2">
                        <Skeleton variant="avatar" width={32} height={32} className="rounded-circle" />
                        <div className="flex-grow-1">
                          <Skeleton width="80%" height="0.9rem" className="mb-1" />
                          <Skeleton width="40%" height="0.7rem" />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
        )
      ) : (() => {
        // The list has already been filtered by getSecuredMainPageData. Do not
        // re-evaluate it on the client: local role state may still be stale.
        const visibleCats = Array.isArray(categories) ? categories : [];
        const safeGroups = Array.isArray(groups) ? groups : [];
        const groupsWithCats = safeGroups.filter(g => visibleCats.some(c => c.group_id === g.id));
        // Categories that are not attached to any known group must still be
        // visible — otherwise a stale/empty groups cache blanks the whole page.
        const ungroupedCats = visibleCats.filter(c => !c.group_id || !safeGroups.some(g => g.id === c.group_id));

        const renderCategoryRows = (cats) => cats.map(cat => (
          <tr key={cat.id}>
            <td data-label={t('forum.category')}>
              <Link to={`/category/${cat.id}`} className="fw-bold d-block text-decoration-none h5 mb-1 cat-link">
                {resolveField(cat.title, lang)}
              </Link>
              <div className="text-muted cat-desc" style={{ lineHeight: 1.2, fontSize: '0.875rem' }}>
                {resolveField(cat.description, lang)}
              </div>
              {/* Mobile Stats Line */}
              <div className="d-md-none mt-2 d-flex gap-3 small forum-mobile-stats text-muted">
                <span className="d-flex align-items-center gap-1">
                  <MessageSquare size={12} /> {cat.topics_count || 0}
                </span>
                <span className="d-flex align-items-center gap-1">
                  <FileText size={12} /> {cat.posts_count || 0}
                </span>
              </div>
            </td>
            <td className="text-center align-middle forum-td-stat" data-label={t('forum.topics')}>
              {cat.topics_count || 0}
            </td>
            <td className="text-center align-middle forum-td-stat" data-label={t('forum.posts')}>
              {cat.posts_count || 0}
            </td>
            <td className="align-middle" data-label={t('forum.last_post')}>
              {cat.last_post_topic_id ? (
                <div>
                  <Link
                    to={`/topic/${cat.last_post_topic_id}`}
                    className="d-block fw-semibold text-decoration-none text-truncate mb-1 last-topic-link"
                    title={t('stats.to_first_post')}
                  >
                    {cat.last_post_topic_title || '—'}
                  </Link>

                  {(() => {
                    const lastVisitRaw = readMap[cat.last_post_topic_id];
                    const lastReadOffset = lastVisitRaw?.offset ?? null;
                    const lastVisitValue = lastVisitRaw?.timestamp || lastVisitRaw;
                    const effectiveLastVisitMs = unreadFloor(lastVisitValue, profile?.created_at);
                    const lastPostMs = toMillis(cat.last_post_at);
                    // The server owns read state, but local session visits
                    // (effectiveLastVisitMs >= lastPostMs) take immediate precedence
                    // over a stale server-side snapshot. A category is unread only if
                    // the server considers it unread AND this device has not visited
                    // it since the last post.
                    const serverUnread = typeof cat.unread === 'boolean' ? cat.unread : null;
                    const isLocallyRead = effectiveLastVisitMs >= lastPostMs;
                    const isUnreadByServer = serverUnread !== null ? serverUnread : true;
                    const hasUnread = !!user &&
                      profile?.role !== 'pending' &&
                      cat.last_post_author_ref?.user_id !== user?.uid &&
                      isUnreadByServer &&
                      !isLocallyRead;

                    return (
                      <LastPostInfo
                        topicId={cat.last_post_topic_id}
                        lastPostAt={cat.last_post_at}
                        author={cat.last_post_author_ref}
                        hasUnread={hasUnread}
                        lastReadOffset={lastReadOffset}
                        postsCount={cat.last_post_topic_posts_count || null}
                        lang={lang}
                      />
                    );
                  })()}
                </div>
              ) : (
                <span className="text-muted small">{t('forum.no_posts')}</span>
              )}
            </td>
          </tr>
        ));

        const renderTable = (cats, key) => (
          <Card key={key} className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
            <Table hover responsive className="mb-0 forum-table forum-table-sub">
              <thead>
                <tr>
                  <th style={{ minWidth: 260 }}>{t('forum.category')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.topics')}</th>
                  <th className="text-center" style={{ width: '100px', whiteSpace: 'nowrap' }}>{t('forum.posts')}</th>
                  <th style={{ minWidth: 180 }}>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {renderCategoryRows(cats)}
              </tbody>
            </Table>
          </Card>
        );

        if (visibleCats.length === 0) {
          return (
            <ForumEmptyState
              className="mb-4"
              icon={Folder}
              title={t('forum.no_categories')}
              description={t('forum.no_categories_desc')}
            />
          );
        }

        return (
          <>
            {groupsWithCats.map(group => (
              <React.Fragment key={group.id}>
                <div className="d-flex align-items-center forum-group-header">
                  <h4 className="mb-0">
                    {resolveField(group.title, lang)}
                  </h4>
                </div>
                {renderTable(
                  visibleCats.filter(cat => cat.group_id === group.id),
                  `group-${group.id}`
                )}
              </React.Fragment>
            ))}
            {ungroupedCats.length > 0 && (
              <>
                {groupsWithCats.length > 0 && (
                  <div className="d-flex align-items-center forum-group-header">
                    <h4 className="mb-0">{t('forum.uncategorized')}</h4>
                  </div>
                )}
                {renderTable(ungroupedCats, 'ungrouped')}
              </>
            )}
          </>
        );
      })()}

      <ForumStats />
    </div>
  );
};

export default MainPage;
