import React, { useState, useEffect } from 'react';
import { Card, Table, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { Folder } from 'lucide-react';
import { subscribeToCategories } from '../api/forum';
import LastPostInfo from '../components/common/LastPostInfo';
import ForumStats from '../components/layout/ForumStats';
import Skeleton from '../components/common/Skeleton';

const MainPage = () => {
  const { t, lang } = useI18n();
  const { user, profile, roles, readMap, hasPermission, PERMISSIONS } = useAuth();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeToCategories((data) => {
      setCategories(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);


  return (
    <Container className="pt-5 pb-4">

      <Card className="shadow-sm border-0">
        {loading ? (
          <div className="p-0">
            <Table responsive className="mb-0 align-middle">
              <thead>
                <tr>
                  <th style={{ minWidth: 300 }}>{t('forum.category')}</th>
                  <th className="text-center">{t('forum.topics')}</th>
                  <th className="text-center">{t('forum.posts')}</th>
                  <th>{t('forum.last_post')}</th>
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
        ) : categories.filter(cat => hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat })).length === 0 ? (
          <div className="p-5 text-center text-muted">
            <div className="mb-3 d-flex justify-content-center">
              <Folder size={48} strokeWidth={1} />
            </div>
            <h5 className="mb-2">{t('forum.no_categories')}</h5>
            <p className="mb-0 small">{t('forum.no_categories_desc')}</p>
          </div>
        ) : (
          <Table hover responsive className="mb-0">
            <thead>
              <tr>
                <th style={{ minWidth: 300 }}>{t('forum.category')}</th>
                <th className="text-center">{t('forum.topics')}</th>
                <th className="text-center">{t('forum.posts')}</th>
                <th>{t('forum.last_post')}</th>
              </tr>
            </thead>
            <tbody>
              {categories
                .filter(cat => hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat }))
                .map(cat => (
                <tr key={cat.id}>
                  <td>
                    <Link to={`/category/${cat.id}`} className="fw-bold d-block text-decoration-none h5 mb-1">
                      {typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title}
                    </Link>
                    <div className="text-muted" style={{ lineHeight: 1.2, fontSize: '0.875rem' }}>
                      {typeof cat.description === 'object' ? (lang === 'ru' ? cat.description.ru : cat.description.en) : cat.description}
                    </div>
                  </td>
                  <td className="text-center align-middle">{cat.topics_count || 0}</td>
                  <td className="text-center align-middle">{cat.posts_count || 0}</td>
                  <td className="align-middle">
                    {cat.last_post_topic_id ? (
                      <div>
                        <Link
                          to={`/topic/${cat.last_post_topic_id}`}
                          className="d-block fw-semibold text-decoration-none text-truncate mb-1"
                          style={{ maxWidth: 200 }}
                        >
                          {cat.last_post_topic_title || '—'}
                        </Link>
                        
                        {(() => {
                          const lastVisitRaw = readMap[cat.last_post_topic_id];
                          const lastVisitMs = lastVisitRaw?.toMillis ? lastVisitRaw.toMillis() : (lastVisitRaw || 0);
                          const registrationMs = profile?.created_at?.toMillis?.() || 0;
                          const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);
                          const lastPostMs = cat.last_post_at?.toMillis?.() ?? 0;
                          const hasUnread = !!user && profile?.status !== 'pending' && cat.last_post_author_id !== user?.uid && lastPostMs > effectiveLastVisitMs;
                          
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
        )}
      </Card>

      <ForumStats />
    </Container>
  );
};

export default MainPage;
