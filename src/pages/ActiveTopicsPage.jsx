import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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

// THE PAGER IS ALWAYS RENDERED when there is more than one page, and
// this is the floor.
//
// The list previously had no pagination at all: it drew whatever fifty rows came
// back and reported "everything" — so past that point the forums simply stopped
// being listed, with nothing on screen to say so.
//
// So the control is rendered whenever totalPages > 1 (ForumPagination itself
// returns null for a single page). An empty <nav> wrapper must never render:
// it adds a 1rem margin and an empty box to the DOM.
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
  const totalPages = Math.max(1, realPages);

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main id="forum-view" className="forum-view" data-forum-id="active-topics">
      <nav id="forum-breadcrumbs-top" aria-label="breadcrumb">
        <ForumBreadcrumbs
          items={[{ label: t('stats.active_topics'), active: true }]}
        />
      </nav>

      <header id="forum-view-header" className="category-header">
        <div className="category-header-heading">
          <h1 className="category-header-title">{t('stats.top_discussed')}</h1>
          <p className="category-header-description">
            {t('stats.top_discussed_desc')}
          </p>
        </div>
      </header>

      {loading ? (
        <section id="forum-topic-list" className="forum-topic-list">
          <div className="forum-view-empty forum-view-loading">
            <span className="forum-view-spinner" role="status" />
            {t('common.loading')}
          </div>
        </section>
      ) : visibleTopics.length === 0 ? (
        <ForumEmptyState
          className="forum-view-empty-state"
          icon={MessageSquare}
          title={t('stats.no_topics', 'Тем пока нет')}
          description={t('stats.no_topics_desc', 'Как только появится тема, она отобразится здесь.')}
        />
      ) : (
        <section id="forum-topic-list" className="forum-topic-list">
          <div className="category-subtitle has-category">
            <span className="category-col--topic">{t('forum.topic')}</span>
            <span className="category-col--category">{t('forum.category')}</span>
            <span className="category-col--replies">{t('forum.replies')}</span>
            <span className="category-col--lastpost">{t('forum.last_post')}</span>
          </div>
          <div className="topic-list">
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
          </div>
        </section>
      )}

      {/* Only render the wrapper when the pager actually shows pages;
          ForumPagination returns null for a single page, so an empty
          <nav> would only add margin and an empty box to the DOM. */}
      {!loading && totalPages > 1 && (
        <ForumPagination
          currentPage={Math.min(currentPage, totalPages)}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          className="forum-pagination-view"
        />
      )}

      <div className="forum-view-footer">
        <Link to="/" className="forum-view-back">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>
    </main>
  );
};

export default ActiveTopicsPage;
