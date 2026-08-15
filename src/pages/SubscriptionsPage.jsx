import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { fetchUserSubscribedTopics } from '../api/subscriptions';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import { usePageTitle } from '../contexts/TitleProvider';

const SubscriptionsPage = () => {
  const { t, lang } = useI18n();
  const { user, hasPermission, PERMISSIONS, categories } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPageTitle(t('nav.subscriptions', 'Подписки'));
  }, [setPageTitle, t, lang]);

  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  useEffect(() => {
    if (!user?.uid) {
      setTopics([]);
      setLoading(false);
      return;
    }

    let isMounted = true;
    fetchUserSubscribedTopics(user.uid)
      .then(data => {
        if (isMounted) {
          setTopics(data);
          setLoading(false);
        }
      })
      .catch(err => {
        console.error('[SubscriptionsPage] fetch error:', err);
        if (isMounted) setLoading(false);
      });

    return () => { isMounted = false; };
  }, [user?.uid]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title;
  };

  // Filter topics user has permission to view
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
        items={[{ label: t('nav.subscriptions', 'Подписки'), active: true }]} 
      />

      <div className="mb-4">
        <h2>{t('nav.subscriptions', 'Подписки')}</h2>
        <p className="text-muted small mb-0">
          {t('stats.subscribed_topics_desc', 'Темы, на обновления которых вы подписаны')}
        </p>
      </div>

      <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading', 'Загрузка...')}
          </div>
        ) : filteredTopics.length === 0 ? (
          <div className="p-5 text-center text-muted">
            {t('stats.no_subscriptions', 'У вас пока нет активных подписок на темы')}
          </div>
        ) : (
          <>
            <Table hover responsive className="mb-0 align-middle forum-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>{t('forum.topic', 'Тема')}</th>
                  <th className="d-none d-md-table-cell" style={{ width: '15%' }}>{t('forum.category', 'Категория')}</th>
                  <th className="text-center">{t('forum.replies', 'Ответов')}</th>
                  <th>{t('forum.last_post', 'Последнее')}</th>
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
          {t('common.back_to_main', 'На главную')}
        </Link>
      </div>
    </Container>
  );
};

export default SubscriptionsPage;
