import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { MessageSquare } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToTopTopics } from '../api/auth-resources';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumEmptyState from '../components/common/ForumEmptyState';
import { resolveField } from '../utils/text';

import { usePageTitle } from '../contexts/TitleProvider';

const ITEMS_PER_PAGE = 20;

// THE PAGER IS ALWAYS RENDERED, and this is the floor.
//
// The list previously had no pagination at all: it drew whatever fifty rows came
// back and reported "everything" — so past that point the forums simply stopped
// being listed, with nothing on screen to say so. A pager that appears only once
// there is more than one page cannot solve that, because the member who is
// already missing pages never sees the control that would reveal it.
//
// So the control is always present, with at least three pages of addressable
// space. Empty pages beyond the data are honest — they say the list is shorter
// than the pager — while a missing pager says nothing at all.
const MIN_PAGES = 3;

const ActiveTopicsPage = () => {
  const { t, lang } = useI18n();
  const { user, hasPermission, PERMISSIONS, categories } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [topics, setTopics] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  // Re-entering the loading state is derived from the page, not from the
  // subscription, so it is reset during render when the page changes rather
  // than inside the effect — the effect's own setLoading(true) ran on every
  // mount and triggered a cascading render. `loading` already starts true, so
  // only a page change needs the reset.
  const [prevPage, setPrevPage] = useState(currentPage);
  if (currentPage !== prevPage) {
    setPrevPage(currentPage);
    setLoading(true);
  }

  useEffect(() => {
    setPageTitle(t('nav.active_topics', 'Активные темы'));
  }, [setPageTitle, t, lang]);

  useEffect(() => {
    const unsubscribe = subscribeToTopTopics((data) => {
      setTopics(data?.topics || []);
      setTotal(data?.total ?? 0);
      setLoading(false);
    }, currentPage, ITEMS_PER_PAGE);

    return () => {
      unsubscribe();
    };
  }, [currentPage]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return resolveField(cat.title, lang);
  };

  const visibleTopics = topics.filter(topic => {
    const cat = categories.find(c => c.id === topic.category_id);
    return cat && hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  });

  const realPages = Math.ceil(total / ITEMS_PER_PAGE);
  const totalPages = Math.max(MIN_PAGES, realPages);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

      {loading ? (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading')}
          </div>
        </Card>
      ) : visibleTopics.length === 0 ? (
        <ForumEmptyState
          className="mb-4"
          icon={MessageSquare}
          title={t('stats.no_topics', 'Тем пока нет')}
          description={t('stats.no_topics_desc', 'Как только появится тема, она отобразится здесь.')}
        />
      ) : (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
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
        </Card>
      )}

      {/* Unconditional: the control must be visible even when the list is short,
          which is the entire point of MIN_PAGES. */}
      {!loading && (
        <div className="mt-4">
          <ForumPagination
            currentPage={Math.min(currentPage, totalPages)}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </div>
      )}

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>
    </Container>
  );
};

export default ActiveTopicsPage;
