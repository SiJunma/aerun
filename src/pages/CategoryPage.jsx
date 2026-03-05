import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Container, Card, Table, Button, Breadcrumb } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { subscribeToTopics, subscribeToCategories } from '../api/forum';

const CategoryPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const [category, setCategory] = useState(null);
  const [topics, setTopics] = useState([]);

  useEffect(() => {
    // We subscribe to all categories to find the one we need by ID
    // (A simpler way would be getCategory, but our forum.js uses snapshots)
    const unsubCat = subscribeToCategories((cats) => {
      const found = cats.find(c => c.id === id);
      if (found) setCategory(found);
    });

    const unsubTopics = subscribeToTopics(id, setTopics);

    return () => {
      unsubCat();
      unsubTopics();
    };
  }, [id]);

  const categoryTitle = category ? (
    typeof category.title === 'object' ? (lang === 'ru' ? category.title.ru : category.title.en) : category.title
  ) : '...';

  return (
    <Container className="py-4">
      <Breadcrumb className="mb-4">
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: "/" }}>{t('nav.home')}</Breadcrumb.Item>
        <Breadcrumb.Item active>{categoryTitle}</Breadcrumb.Item>
      </Breadcrumb>

      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2>{categoryTitle}</h2>
        <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
          {t('forum.create_topic')}
        </Button>
      </div>

      <Card className="shadow-sm border-0">
        <Table hover responsive className="mb-0">
          <thead>
            <tr>
              <th>{t('forum.topic')}</th>
              <th className="text-center">{t('forum.replies')}</th>
              <th className="text-center">{t('forum.views')}</th>
              <th>{t('forum.last_post')}</th>
            </tr>
          </thead>
          <tbody>
            {topics.map(topic => (
              <tr key={topic.id}>
                <td>
                  <Link to={`/topic/${topic.id}`} className="fw-bold d-block text-decoration-none h6 mb-1">
                    {topic.title}
                  </Link>
                  <small className="text-muted">
                    {t('forum.author')}: <span className="text-primary">{topic.author}</span>
                  </small>
                </td>
                <td className="text-center align-middle">{topic.replies}</td>
                <td className="text-center align-middle">{topic.views}</td>
                <td className="align-middle">
                  <div className="small">
                    <div className="text-muted">
                      by <span className="text-secondary">{topic.author}</span>
                      <br />
                      {topic.lastPost}
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
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
