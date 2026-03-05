import React, { useState, useEffect } from 'react';
import { Card, Table, Badge, Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { subscribeToCategories } from '../api/forum';

const MainPage = () => {
  const { t, lang } = useI18n();
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    const unsubscribe = subscribeToCategories(setCategories);
    return () => unsubscribe();
  }, []);

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
                  {cat.lastPost ? (
                    <div className="small">
                      <Link to={`/topic/${cat.lastPost.topicId}`} className="d-block mb-1 fw-bold text-decoration-none transition-hover">
                        {cat.lastPost.topicTitle}
                      </Link>
                      <div className="text-muted">
                        by <span className="text-secondary">{cat.lastPost.author}</span>
                        <br />
                        {cat.lastPost.timestamp}
                      </div>
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
    </Container>
  );
};

export default MainPage;
