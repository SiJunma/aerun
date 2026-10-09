import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table } from 'react-bootstrap';
import { BellOff } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { fetchUserSubscribedTopics } from '../api/subscriptions';
import TopicRow from '../components/common/TopicRow';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumEmptyState from '../components/common/ForumEmptyState';
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
  }, [user?.uid, currentPage]);

  const getCategoryName = (id) => {
    const cat = categories.find(c => c.id === id);
    if (!cat) return '';
    return typeof cat.title === 'object' ? (lang === 'ru' ? cat.title.ru : cat.title.en) : cat.title;
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

      {displayLoading ? (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {t('common.loading', 'Загрузка...')}
          </div>
        </Card>
      ) : filteredTopics.length === 0 ? (
        <ForumEmptyState
          className="mb-4"
          icon={BellOff}
          title={t('stats.no_subscriptions', 'Подписок пока нет')}
          description={t('stats.no_subscriptions_desc', 'Подпишитесь на тему, чтобы следить за обновлениями.')}
        />
      ) : (
        <Card className="border-0 mb-4 overflow-hidden forum-group-card bg-transparent shadow-none">
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
        </Card>
      )}

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          {t('common.back_to_main', 'На главную')}
        </Link>
      </div>
    </Container>
  );
};

export default SubscriptionsPage;
