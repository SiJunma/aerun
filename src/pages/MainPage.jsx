import React, { useState, useEffect } from 'react';
import { Card, Table, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { subscribeToCategories } from '../api/forum';
import ForumAuthorName from '../components/common/ForumAuthorName';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const MainPage = () => {
  const { t, lang } = useI18n();
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    const unsubscribe = subscribeToCategories(setCategories);
    return () => unsubscribe();
  }, []);

  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '—';
    }
  };

  return (
    <Container className="py-4">
      <h1 className="mb-4">{t('common.welcome')}</h1>
      <p className="lead text-muted mb-5">{t('common.description')}</p>

      <Card className="shadow-sm border-0">
        <Table hover responsive className="mb-0">
          <thead>
            <tr>
              <th>{t('forum.category')}</th>
              <th className="text-center">{t('forum.topics')}</th>
              <th className="text-center">{t('forum.posts')}</th>
              <th>{t('forum.last_post')}</th>
            </tr>
          </thead>
          <tbody>
            {categories.map(cat => (
              <tr key={cat.id}>
                <td>
                  <Link to={`/category/${cat.id}`} className="fw-bold d-block text-decoration-none h5 mb-1">
                    {typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title}
                  </Link>
                  <small className="text-muted">
                    {typeof cat.description === 'object' ? (lang === 'ru' ? cat.description.ru : cat.description.en) : cat.description}
                  </small>
                </td>
                <td className="text-center align-middle">{cat.topics_count || 0}</td>
                <td className="text-center align-middle">{cat.posts_count || 0}</td>
                <td className="align-middle">
                  {cat.last_post_topic_id ? (() => {
                    const lastVisitKey = `lastVisit_${cat.last_post_topic_id}`;
                    const lastVisit = localStorage.getItem(lastVisitKey);
                    const lastPostMs = cat.last_post_at?.toMillis?.() ?? 0;
                    const hasUnread = !lastVisit || lastPostMs > parseInt(lastVisit, 10);
                    return (
                      <div className="small">
                        <Link
                          to={`/topic/${cat.last_post_topic_id}`}
                          className="d-block fw-semibold text-decoration-none text-truncate mb-1"
                          style={{ maxWidth: 200 }}
                        >
                          {cat.last_post_topic_title || '—'}
                        </Link>
                        <Link
                          to={`/topic/${cat.last_post_topic_id}?goLast=1`}
                          className="text-decoration-none d-flex align-items-center gap-1 text-muted"
                        >
                          {hasUnread && (
                            <span
                              title={lang === 'ru' ? 'Новые сообщения' : 'New posts'}
                              style={{
                                display: 'inline-block',
                                width: 7, height: 7,
                                borderRadius: '50%',
                                background: 'var(--bs-warning)',
                                flexShrink: 0
                              }}
                            />
                          )}
                          <ForumAuthorName
                            userId={cat.last_post_author_id}
                            characterId={cat.last_post_author_character_id}
                            isCharacter={!!cat.last_post_is_character}
                            fallbackName={cat.last_post_author}
                          />
                          <span>·</span>
                          <span>{formatTime(cat.last_post_at)}</span>
                        </Link>
                      </div>
                    );
                  })() : (
                    <span className="text-muted small">{t('forum.no_posts')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </Container>
  );
};

export default MainPage;
