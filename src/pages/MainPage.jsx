import React, { useState, useEffect } from 'react';
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
    <div id="forum-index" className="forum-index">
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
          <div className="forum-skeleton-group">
            <div className="category-group-header skeleton-category-header">
              <Skeleton width="180px" height="1.4rem" />
            </div>
            <div className="category-content skeleton-category-content">
              <div className="category-group-subtitle">
                <span className="category-col--forum">{t('forum.category')}</span>
                <span className="category-col--topics">{t('forum.topics')}</span>
                <span className="category-col--posts">{t('forum.posts')}</span>
                <span className="category-col--lastpost">{t('forum.last_post')}</span>
              </div>
              {[...Array(4)].map((_, i) => (
                <div key={i} className="forum-item skeleton-forum-item">
                  <div className="forum-info">
                    <Skeleton width="50%" height="1.4rem" className="forum-skeleton-gap" />
                    <Skeleton width="80%" height="0.9rem" />
                  </div>
                  <div className="forum-topics">
                    <Skeleton width={30} height="1rem" className="forum-skeleton-stat" />
                  </div>
                  <div className="forum-posts">
                    <Skeleton width={30} height="1rem" className="forum-skeleton-stat" />
                  </div>
                  <div className="forum-last-post last-post-strip" data-label={t('forum.last_post')}>
                    <div className="forum-skeleton-last">
                      <Skeleton variant="avatar" width={32} height={32} className="forum-skeleton-avatar" />
                      <div className="forum-skeleton-last-lines">
                        <Skeleton width="80%" height="0.9rem" className="forum-skeleton-gap" />
                        <Skeleton width="40%" height="0.7rem" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
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

        const renderCategoryRows = (cats) => cats.map(cat => {
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
            <article
              key={cat.id}
              id={`forum-item-${cat.id}`}
              className={`forum-item forum-item-${cat.id}${hasUnread ? ' is-unread is-new' : ''}`}
              data-forum-id={cat.id}
            >
              <div className="forum-info">
                <h3 className="forum-title">
                  <Link to={`/category/${cat.id}`} className="cat-link">
                    {resolveField(cat.title, lang)}
                  </Link>
                </h3>
                {cat.description && (
                  <div className="forum-description cat-desc">
                    {resolveField(cat.description, lang)}
                  </div>
                )}
                {/* Mobile Stats Line */}
                <div className="forum-mobile-stats d-md-none">
                  <span className="forum-mobile-stat">
                    <MessageSquare size={12} /> {cat.topics_count || 0}
                  </span>
                  <span className="forum-mobile-stat">
                    <FileText size={12} /> {cat.posts_count || 0}
                  </span>
                </div>
              </div>
              <div className="forum-topics" data-value={cat.topics_count || 0}>
                {cat.topics_count || 0}
              </div>
              <div className="forum-posts" data-value={cat.posts_count || 0}>
                {cat.posts_count || 0}
              </div>
              <div className="forum-last-post last-post-strip" data-label={t('forum.last_post')}>
                {cat.last_post_topic_id ? (
                  <div className="last-post-content">
                    <Link
                      to={`/topic/${cat.last_post_topic_id}`}
                      className="last-topic-link"
                      title={t('stats.to_first_post')}
                    >
                      {cat.last_post_topic_title || '—'}
                    </Link>
                    <LastPostInfo
                      topicId={cat.last_post_topic_id}
                      lastPostAt={cat.last_post_at}
                      author={cat.last_post_author_ref}
                      hasUnread={hasUnread}
                      lastReadOffset={lastReadOffset}
                      postsCount={cat.last_post_topic_posts_count || null}
                      lang={lang}
                    />
                  </div>
                ) : (
                  <span className="forum-no-posts">{t('forum.no_posts')}</span>
                )}
              </div>
            </article>
          );
        });

        const renderCategoryGroup = (cats, key, groupTitle, groupId) => (
          <section
            key={key}
            id={groupId ? `forum-category-${groupId}` : 'forum-category-ungrouped'}
            className={`forum-category ${groupId ? ` category-${groupId}` : ' category-ungrouped'}`}
            data-category-id={groupId || 'ungrouped'}
          >
            <header className="category-group-header">
              <h2 className="category-group-title">
                {groupTitle}
              </h2>
            </header>
            <div className="category-content">
              <div className="category-group-subtitle">
                <span className="category-col--forum">{t('forum.category')}</span>
                <span className="category-col--topics">{t('forum.topics')}</span>
                <span className="category-col--posts">{t('forum.posts')}</span>
                <span className="category-col--lastpost">{t('forum.last_post')}</span>
              </div>
              {renderCategoryRows(cats)}
            </div>
          </section>
        );

        if (visibleCats.length === 0) {
          return (
            <ForumEmptyState
              className="forum-index-empty"
              icon={Folder}
              title={t('forum.no_categories')}
              description={t('forum.no_categories_desc')}
            />
          );
        }

        return (
          <main id="forum-main" className="forum-main">
            {groupsWithCats.map(group =>
              renderCategoryGroup(
                visibleCats.filter(cat => cat.group_id === group.id),
                `group-${group.id}`,
                resolveField(group.title, lang),
                group.id
              )
            )}
            {ungroupedCats.length > 0 &&
              renderCategoryGroup(
                ungroupedCats,
                'ungrouped',
                t('forum.uncategorized'),
                null
              )
            }
          </main>
        );
      })()}

      <ForumStats />
    </div>
  );
};

export default MainPage;
