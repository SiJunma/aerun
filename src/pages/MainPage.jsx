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
  }, []);

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
        const visibleCats = categories;
        const groupsWithCats = groups.filter(g => visibleCats.some(c => c.group_id === g.id));

        // Categories that belong to no group are rendered NOWHERE by the loop
        // below: it walks GROUPS and keeps the categories matching each one, so
        // `cat.group_id === g.id` never matches "". Such a category is invisible
        // on the forum index while existing perfectly well in the database.
        //
        // The empty-state guard counts `categories`, not rendered rows, so when
        // every category is ungrouped the index showed neither the list nor the
        // "no categories" message — a blank area with no way to diagnose it.
        //
        // They get their own section here so the row stays reachable and the
        // misconfiguration is legible instead of silent.
        const UNGROUPED_KEY = '__ungrouped__';
        const ungroupedCats = visibleCats.filter(
          c => !c.group_id || !groups.some(g => g.id === c.group_id)
        );
        const renderGroups = ungroupedCats.length
          ? [...groupsWithCats, { id: UNGROUPED_KEY, __isUngrouped: true }]
          : groupsWithCats;

        // One accessor for both kinds of group, so the table markup below stays
        // a single branch instead of a duplicated row.
        const catsForGroup = (group) => (group.__isUngrouped
          ? ungroupedCats
          : visibleCats.filter(cat => cat.group_id === group.id));

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

        return renderGroups.map(group => (
          <Card key={group.id} className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
            <div className="d-flex align-items-center forum-group-header">
              <h4 className="mb-0">
                {group.__isUngrouped
                  ? (lang === 'ru' ? 'Без группы' : 'Unassigned')
                  : resolveField(group.title, lang)}
              </h4>
            </div>
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
                {catsForGroup(group).map(cat => (
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
                              const lastVisitMs = lastVisitValue?.toMillis ? lastVisitValue.toMillis() : (lastVisitValue || 0);
                              const registrationMs = profile?.created_at?.toMillis?.() || 0;
                              const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);
                              const lastPostMs = cat.last_post_at 
                                ? (cat.last_post_at.toMillis ? cat.last_post_at.toMillis() : new Date(cat.last_post_at).getTime())
                                : 0;
                              const hasUnread = !!user && profile?.role_id !== 'pending' && cat.last_post_author_id !== user?.uid && lastPostMs > effectiveLastVisitMs;

                              return (
                                <LastPostInfo
                                  topicId={cat.last_post_topic_id}
                                  lastPostAt={cat.last_post_at}
                                  authorId={cat.last_post_author_id}
                                  authorCharacterId={cat.last_post_author_character_id}
                                  isCharacter={!!cat.last_post_is_character}
                                  authorName={cat.last_post_author}
                                  authorAvatar={cat.last_post_author_avatar}
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
                  ))}
              </tbody>
            </Table>
          </Card>
        ));
      })()}

      <ForumStats />
    </div>
  );
};

export default MainPage;
