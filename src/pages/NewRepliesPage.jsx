import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToLatestTopics } from '../api/auth-resources';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';

const NewRepliesPage = () => {
  const { t, lang } = useI18n();
  const { user, markAllRead, isMarkingAllRead, unreadTopicsCount, hasPermission, PERMISSIONS, categories } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  useEffect(() => {
    if (categories.length === 0) return;
    
    const allowedCategories = categories.filter(c => hasPermission(PERMISSIONS.VIEW_FORUM, { category: c })).map(c => c.id);
    
    if (allowedCategories.length === 0) {
      setTopics([]);
      setLoading(false);
      return;
    }

    const unsubTopics = subscribeToLatestTopics(allowedCategories, (data) => {
      setTopics(data);
      setLoading(false);
    }, 200);

    return () => {
      unsubTopics();
    };
  }, [categories, hasPermission]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title;
  };

  // Pagination logic
  const filteredTopics = topics.filter(topic => {
    const cat = categories.find(c => c.id === topic.category_id);
    return cat && hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  });

  const totalPages = Math.ceil(filteredTopics.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTopics = filteredTopics.slice(indexOfFirstItem, indexOfLastItem);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <Container className="py-4">
      <ForumBreadcrumbs 
        items={[{ label: t('stats.latest_replies'), active: true }]} 
      />

      <div className="mb-4 d-flex justify-content-between align-items-end">
        <div>
          <h2>{t('stats.latest_replies')}</h2>
          <p className="text-muted small mb-0">
            {t('stats.latest_replies_desc')}
          </p>
        </div>
        <div>
          <button 
            className="btn btn-outline-primary btn-sm rounded-pill px-3 d-flex align-items-center gap-2"
            onClick={() => markAllRead()}
            disabled={filteredTopics.length === 0 || unreadTopicsCount === 0 || isMarkingAllRead}
          >
            {isMarkingAllRead && (
              <div className="spinner-border spinner-border-sm" role="status">
                <span className="visually-hidden">Loading...</span>
              </div>
            )}
            {t('forum.mark_all_read')}
          </button>
        </div>
      </div>

      <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        ) : filteredTopics.length === 0 ? (
          <div className="p-5 text-center text-muted">
            {t('stats.no_topics')}
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
