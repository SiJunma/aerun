import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToTopTopics } from '../api/auth-resources';
import TopicRow from '../components/common/TopicRow';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import { resolveField } from '../utils/text';

import { usePageTitle } from '../contexts/TitleProvider';

const ActiveTopicsPage = () => {
  const { t, lang } = useI18n();
  const { user, hasPermission, PERMISSIONS, categories } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPageTitle(t('nav.active_topics', 'Активные темы'));
  }, [setPageTitle, t, lang]);

  useEffect(() => {
    const unsubTopics = subscribeToTopTopics((data) => {
      setTopics(data);
      setLoading(false);
    }, 50); // Show top 50 topics

    return () => {
      unsubTopics();
    };
  }, []);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return resolveField(cat.title, lang);
  };

  const visibleTopics = topics.filter(topic => {
    const cat = categories.find(c => c.id === topic.category_id);
    return cat && hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  });

  return (
    <Container className="py-4">
      <ForumBreadcrumbs 
        items={[{ label: t('stats.active_topics'), active: true }]} 
      />

      <div className="mb-4">
        <h2>{t('stats.top_discussed')}</h2>
        <p className="text-muted small">
          {t('stats.top_discussed_desc')}
        </p>
      </div>

      <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        ) : visibleTopics.length === 0 ? (
          <div className="p-5 text-center text-muted">
            {t('stats.no_topics')}
          </div>
        ) : (
          <Table hover responsive className="mb-0 align-middle forum-table">
            <thead>
              <tr>
                <th style={{ width: '40%' }} className="text-start">{t('forum.topic')}</th>
                <th className="d-none d-md-table-cell text-start" style={{ width: '15%' }}>{t('forum.category')}</th>
                <th className="text-center">{t('forum.replies')}</th>
                <th className="text-start">{t('forum.last_post')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleTopics.map(topic => (
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

export default ActiveTopicsPage;
