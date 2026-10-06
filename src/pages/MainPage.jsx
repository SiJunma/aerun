import React, { useState, useEffect } from 'react';
import { Card, Table, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { Folder, MessageSquare, FileText } from 'lucide-react';
import { subscribeToCategoryGroups } from '../api/categories';
import LastPostInfo from '../components/common/LastPostInfo';
import ForumStats from '../components/layout/ForumStats';
import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import { resolveField } from '../utils/text';
import { usePageTitle } from '../contexts/TitleProvider';

const MainPage = () => {
  const { t, lang } = useI18n();
  const { user, profile, readMap, categories, forumStateLoading, forumStateError, refreshForumState } = useAuth();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timeoutExpired, setTimeoutExpired] = useState(false);
  const { setPageTitle } = usePageTitle();

  useEffect(() => {
    setPageTitle('');
    const unsubGroups = subscribeToCategoryGroups((data) => {
      setGroups(data);
      setLoading(false);
    });

    return () => {
      unsubGroups();
    };
  }, []);


  // While a logged-in user's profile is still loading from Firestore, treat as loading
  // to prevent a flash of content with wrong permissions (profile=null → role='player', then
  // flips to 'pending' once profile arrives and categories may disappear).
  const profileLoading = !!user && profile === null;
  // Categories are supplied only by getSecuredMainPageData. An empty list is a
  // valid server result, so use its explicit loading state rather than length.
  const catsLoading = forumStateLoading;

  useEffect(() => {
    if (loading || profileLoading || catsLoading) {
      const timer = setTimeout(() => {
        setTimeoutExpired(true);
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [loading, profileLoading, catsLoading]);

  return (
    <div className="pt-5 pb-4">

      {(loading || profileLoading || catsLoading) ? (
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
            <Card className="shadow-sm border-0">
              <div className="p-5 text-center text-muted">
                <div className="mb-3 d-flex justify-content-center">
                  <Folder size={48} strokeWidth={1} />
                </div>
                <h5 className="mb-2">{t('forum.no_categories')}</h5>
                <p className="mb-0 small">{t('forum.no_categories_desc')}</p>
              </div>
            </Card>
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
