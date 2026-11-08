import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BellOff } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { fetchUserSubscribedTopics } from '../api/subscriptions';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumEmptyState from '../components/common/ForumEmptyState';
import { usePageTitle } from '../contexts/TitleProvider';
import { resolveField } from '../utils/text';

const SubscriptionsPage = () => {
  const { t, lang } = useI18n();
  const { user, hasPermission, PERMISSIONS, categories, settings } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPageTitle(t('nav.subscriptions', 'Подписки'));
  }, [setPageTitle, t, lang]);

  // Page size follows the SAME admin setting ("topics per page") the category
  // page uses, so a member's subscriptions paginate at the same density as any
  // topic list. It is NOT a hard cap on how many subscriptions are reachable:
  // the pager still spans the server's full `total` (every subscription), so no
  // subscription is ever cut off — the setting only decides how many share a
  // page. The old hardcoded 20 ignored the setting entirely.
  const ITEMS_PER_PAGE = settings?.topicsPerPage || 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  // The page the SERVER was asked for, not a slice of everything it returned.
  const [total, setTotal] = useState(0);

  // Reset the list when the identity or page changes. Doing this during render
  // (rather than by resetting state inside the effect below) removes the
  // synchronous setState the effect used to run on sign-out and on every page
  // change, which cascaded into a second render. The loading flag is set here so
  // a page switch shows the spinner again until the fetch resolves.
  const feedKey = `${user?.uid || ''}:${currentPage}`;
  const [prevFeedKey, setPrevFeedKey] = useState(feedKey);
  if (feedKey !== prevFeedKey) {
    setPrevFeedKey(feedKey);
    setTopics([]);
    setTotal(0);
    setLoading(true);
  }

  // A signed-out visitor is never "loading" — there is nothing to fetch. Showing
  // the empty state instead of an eternal spinner is what the old in-effect guard
  // achieved by setting loading=false; deriving it here does the same without a
  // setState call.
  const displayLoading = user?.uid ? loading : false;

  useEffect(() => {
    // No identity means no subscriptions to read; the render-level reset above
    // has already cleared the list, so the effect simply does nothing.
    if (!user?.uid) return;

    let isMounted = true;
    // currentPage is in the dependency list: it used to be absent, so switching
    // page re-read page 1 and never changed what was on screen — the pager moved
    // and the list did not.
    fetchUserSubscribedTopics(user.uid, currentPage, ITEMS_PER_PAGE)
      .then(data => {
        if (isMounted) {
          setTopics(data.topics);
          setTotal(data.total);
          setLoading(false);
        }
      })
      .catch(err => {
        console.error('[SubscriptionsPage] fetch error:', err);
        if (isMounted) setLoading(false);
      });

    return () => { isMounted = false; };
  }, [user?.uid, currentPage, ITEMS_PER_PAGE]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return resolveField(cat.title, lang);
  };

  // Permission filter, still applied client-side: it narrows THIS page's rows
  // and must not be mistaken for a way to shrink the page count, so the pager
  // divides the server's `total` rather than this filtered length.
  const filteredTopics = topics.filter(topic => {
    const cat = categories.find(c => c.id === topic.category_id);
    return cat && hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  });

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  // NO client-side slice. The server already returned exactly this page; slicing
  // again would drop rows from page 1 and render page 2+ empty.
  const currentTopics = filteredTopics;

  const handlePageChange = (page) => {
    setSearchParams({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main id="forum-view" className="forum-view" data-forum-id="subscriptions">
      <nav id="forum-breadcrumbs-top" aria-label="breadcrumb">
        <ForumBreadcrumbs
          items={[{ label: t('nav.subscriptions', 'Подписки'), active: true }]}
        />
      </nav>

      <header id="forum-view-header" className="forum-view-header">
        <div className="forum-view-heading">
          <h1 className="forum-view-title">{t('nav.subscriptions', 'Подписки')}</h1>
          <p className="forum-view-description">
            {t('stats.subscribed_topics_desc', 'Темы, на обновления которых вы подписаны')}
          </p>
        </div>
      </header>

      {displayLoading ? (
        <section id="forum-topic-list" className="forum-topic-list">
          <div className="forum-view-empty forum-view-loading">
            <span className="forum-view-spinner" role="status" />
            {t('common.loading', 'Загрузка...')}
          </div>
        </section>
      ) : filteredTopics.length === 0 ? (
        <ForumEmptyState
          className="forum-view-empty-state"
          icon={BellOff}
          title={t('stats.no_subscriptions', 'Подписок пока нет')}
          description={t('stats.no_subscriptions_desc', 'Подпишитесь на тему, чтобы следить за обновлениями.')}
        />
      ) : (
        <>
          <section id="forum-topic-list" className="forum-topic-list">
            <div className="topic-list-head has-category">
              <span className="topic-col-topic">{t('forum.topic', 'Тема')}</span>
              <span className="topic-col-category">{t('forum.category', 'Категория')}</span>
              <span className="topic-col-replies">{t('forum.replies', 'Ответов')}</span>
              <span className="topic-col-lastpost">{t('forum.last_post', 'Последнее')}</span>
            </div>
            <div className="topic-list">
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
            </div>
          </section>

          {totalPages > 1 && (
            <nav id="forum-pagination-bottom" className="forum-view-pagination">
              <ForumPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            </nav>
          )}
        </>
      )}

      <div className="forum-view-footer">
        <Link to="/" className="forum-view-back">
          {t('common.back_to_main', 'На главную')}
        </Link>
      </div>
    </main>
  );
};

export default SubscriptionsPage;
