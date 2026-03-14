import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToTopTopics, subscribeToCategories } from '../api/forum';
import TopicRow from '../components/common/TopicRow';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';

const ActiveTopicsPage = () => {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const [topics, setTopics] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubCats = subscribeToCategories(setCategories);
    const unsubTopics = subscribeToTopTopics((data) => {
      setTopics(data);
      setLoading(false);
    }, 50); // Show top 50 topics

    return () => {
      unsubCats();
      unsubTopics();
    };
  }, []);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title;
  };

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

      <Card className="shadow-sm border-0">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        ) : topics.length === 0 ? (
          <div className="p-5 text-center text-muted">
            {t('stats.no_topics')}
          </div>
        ) : (
          <Table hover responsive className="mb-0 align-middle">
            <thead>
              <tr>
                <th style={{ width: '50%' }}>{t('forum.topic')}</th>
                <th className="text-center">{t('forum.replies')}</th>
                <th>{t('forum.last_post')}</th>
              </tr>
            </thead>
            <tbody>
              {topics.map(topic => (
                <TopicRow 
                  key={topic.id}
                  topic={topic}
                  user={user}
                  lang={lang}
                  showCategory={true}
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
