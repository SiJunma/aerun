import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table, Button, Breadcrumb, Badge, Pagination } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToTopics, subscribeToCategories, subscribeToUser } from '../api/forum';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumPagination from '../components/common/ForumPagination';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const CategoryPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [category, setCategory] = useState(null);
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  useEffect(() => {
    const unsubCat = subscribeToCategories((cats) => {
      const found = cats.find(c => c.id === id);
      if (found) setCategory(found);
    });

    const unsubTopics = subscribeToTopics(id, (data) => {
      setTopics(data);
      setLoading(false);
    });

    return () => {
      unsubCat();
      unsubTopics();
    };
  }, [id]);

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';

  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '—';
    }
  };

  const categoryTitle = category ? resolveText(category.title) : '...';

  // Pagination logic
  const totalPages = Math.ceil(topics.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTopics = topics.slice(indexOfFirstItem, indexOfLastItem);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <Container className="py-4">
      <Breadcrumb className="mb-4">
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/' }}>{t('nav.home')}</Breadcrumb.Item>
        <Breadcrumb.Item active>{categoryTitle}</Breadcrumb.Item>
      </Breadcrumb>

      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h2 className="mb-1">{categoryTitle}</h2>
          {category?.description && (
            <p className="text-muted mb-0 small">{resolveText(category.description)}</p>
          )}
        </div>
        <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
          {t('forum.create_topic')}
        </Button>
      </div>

      <Card className="shadow-sm border-0">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {lang === 'ru' ? 'Загрузка...' : 'Loading...'}
          </div>
        ) : topics.length === 0 ? (
          <div className="p-5 text-center">
            <div className="mb-3" style={{ fontSize: '3rem', opacity: 0.3 }}>💬</div>
            <h5 className="text-muted mb-2">
              {lang === 'ru' ? 'Тем пока нет' : 'No topics yet'}
            </h5>
            <p className="text-muted small mb-4">
              {lang === 'ru'
                ? 'Будь первым — создай тему!'
                : 'Be the first to start a discussion!'}
            </p>
            <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
              {t('forum.create_topic')}
            </Button>
          </div>
        ) : (
          <>
            <Table hover responsive className="mb-0 align-middle">
              <thead>
                <tr>
                  <th style={{ width: '50%' }}>{t('forum.topic')}</th>
                  <th className="text-center">{t('forum.replies')}</th>
                  <th className="text-center">{t('forum.views')}</th>
                  <th>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {currentTopics.map(topic => (
                  <tr key={topic.id}>
                    <td>
                      <Link
                        to={`/topic/${topic.id}`}
                        className="fw-bold d-block text-decoration-none h6 mb-1"
                      >
                        {topic.title}
                      </Link>
                      {topic.description && (
                        <div className="text-muted small mb-1 text-truncate" style={{ maxWidth: 480 }}>
                          {topic.description}
                        </div>
                      )}
                      <small className="text-muted d-flex align-items-center gap-1">
                        <ForumAuthorName
                          userId={topic.author_id}
                          characterId={topic.author_character_id}
                          isCharacter={!!topic.is_character}
                          fallbackName={topic.author_name}
                          className="fw-semibold text-secondary"
                        />
                        <span>·</span>
                        {formatTime(topic.created_at)}
                      </small>
                    </td>
                    <td className="text-center">
                      {Math.max(0, (topic.posts_count || 1) - 1)}
                    </td>
                    <td className="text-center">{topic.views || 0}</td>
                    <td>
                      {topic.last_post_at ? (() => {
                        const lastVisitKey = `lastVisit_${topic.id}`;
                        const lastVisit = localStorage.getItem(lastVisitKey);
                        const lastPostMs = topic.last_post_at?.toMillis?.() ?? 0;
                        const hasUnread = topic.last_post_author_id !== user?.uid && (!lastVisit || lastPostMs > parseInt(lastVisit, 10));
                        return (
                          <Link
                            to={`/topic/${topic.id}?goLast=1`}
                            className="text-decoration-none d-block small"
                          >
                            <div className="d-flex align-items-center gap-1 fw-semibold text-primary text-truncate" style={{ maxWidth: 160 }}>
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
                                userId={topic.last_post_author_id}
                                characterId={topic.last_post_author_character_id}
                                isCharacter={!!topic.last_post_is_character}
                                fallbackName={topic.last_post_author || topic.author_name}
                              />
                            </div>
                            <div className="text-muted">{formatTime(topic.last_post_at)}</div>
                          </Link>
                        );
                      })() : (
                        <span className="text-muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
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

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>
    </Container>
  );
};

export default CategoryPage;
