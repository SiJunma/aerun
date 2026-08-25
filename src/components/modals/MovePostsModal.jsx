import React, { useState, useEffect } from 'react';
import { Form, Button, Badge } from 'react-bootstrap';
import ForumModal from '../common/ForumModal';
import { subscribeToCategoryGroups } from '../../api/categories';
import { fetchSecuredTopics } from '../../api/forum';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { resolveField } from '../../utils/text';

/** Strip BBCode tags and collapse whitespace for a plain-text preview. */
const stripBBCode = (text = '') =>
  text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 180);

/**
 * MovePostsModal
 *
 * Props:
 *   show            {boolean}
 *   onHide          {() => void}
 *   posts           {Array}   – Posts on the current page, sorted chronologically
 *   startIndex      {number}  – Starting post number for the current page (e.g. 1, 21, 41)
 *   firstPostId     {string}  – ID of the first post (cannot be moved)
 *   currentTopicId  {string}  – ID of the current topic (excluded from target list)
 *   onConfirm       {async (postIds: string[], targetTopicId: string) => void}
 */
const MovePostsModal = ({
  show,
  onHide,
  posts = [],
  startIndex = 1,
  firstPostId,
  currentTopicId,
  onConfirm,
}) => {
  const { t, lang } = useI18n();
  const { hasPermission, PERMISSIONS, categories: allCategories } = useAuth();

  // ── Post selection ──────────────────────────────────────────────────────────
  const [selectedPostIds, setSelectedPostIds] = useState(new Set());

  // ── Category / Topic target ─────────────────────────────────────────────────
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [targetCategoryId, setTargetCategoryId] = useState('');
  const [topics, setTopics] = useState([]);
  const [targetTopicId, setTargetTopicId] = useState('');
  const [loadingTopics, setLoadingTopics] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // Reset all state every time modal opens
  useEffect(() => {
    if (show) {
      setSelectedPostIds(new Set());
      setTargetCategoryId('');
      setTargetTopicId('');
      setTopics([]);
    }
  }, [show]);

  // Subscribe to categories & groups
  useEffect(() => {
    if (!show) return;

    // Filter from context
    const filtered = allCategories.filter(cat =>
      hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat })
    );
    setCategories(filtered);

    const unsubGroups = subscribeToCategoryGroups((grps) => {
      setGroups(grps);
    });

    return () => { unsubGroups(); };
  }, [show, hasPermission, PERMISSIONS.VIEW_FORUM, allCategories]);

  // Fetch topics when a forum is selected
  useEffect(() => {
    if (!targetCategoryId) {
      setTopics([]);
      setTargetTopicId('');
      return;
    }
    setLoadingTopics(true);
    let isActive = true;

    fetchSecuredTopics(targetCategoryId, 1, 50).then(result => {
      if (!isActive) return;
      const combined = [...(result.pinned || []), ...(result.topics || [])];
      // Exclude current topic from the target list
      const filtered = combined.filter(tp => tp.id !== currentTopicId);
      setTopics(filtered);
      setLoadingTopics(false);
    }).catch(err => {
      if (!isActive) return;
      console.error(err);
      setTopics([]);
      setLoadingTopics(false);
    });

    return () => { isActive = false; };
  }, [targetCategoryId, currentTopicId]);

  const allPageSelected = posts.length > 0 && posts.every(p => selectedPostIds.has(p.id));

  // ── Handlers ────────────────────────────────────────────────────────────────
  const togglePost = (postId) => {
    setSelectedPostIds(prev => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const toggleAllOnPage = () => {
    setSelectedPostIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        posts.forEach(p => next.delete(p.id));
      } else {
        posts.forEach(p => next.add(p.id));
      }
      return next;
    });
  };

  const handleCategoryChange = (catId) => {
    setTargetCategoryId(catId);
    setTargetTopicId('');
  };

  const canConfirm = selectedPostIds.size > 0 && !!targetTopicId && !submitting;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm([...selectedPostIds], targetTopicId);
      onHide();
    } catch (err) {
      console.error('[MovePostsModal]', err);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Build category groups for the forum select ──────────────────────────────
  const groupsWithCats   = groups.filter(g => categories.some(c => c.group_id === g.id));
  const uncategorizedCats = categories.filter(c => !c.group_id || !groups.some(g => g.id === c.group_id));

  // ── Topic select placeholder text ──────────────────────────────────────────
  let topicPlaceholder;
  if (loadingTopics) {
    topicPlaceholder = t('forum.move_posts_loading_topics');
  } else if (!targetCategoryId) {
    topicPlaceholder = t('forum.move_posts_select_forum_first');
  } else if (topics.length === 0) {
    topicPlaceholder = t('forum.move_posts_no_topics');
  } else {
    topicPlaceholder = t('forum.move_posts_select_topic');
  }

  // ── Pagination buttons (compact for long lists) ─────────────────────────────
  const renderPageButtons = () => {
    if (totalPostPages <= 1) return null;

    // Show at most 5 page buttons with ellipsis
    const pages = Array.from({ length: totalPostPages }, (_, i) => i + 1);

    return (
      <div className="d-flex align-items-center justify-content-center gap-1 mt-2 flex-wrap">
        <Button
          variant="outline-secondary"
          size="sm"
          disabled={safePostPage === 1}
          onClick={() => setPostPage(p => Math.max(1, p - 1))}
          className="py-0 px-2"
          style={{ minWidth: '28px' }}
        >‹</Button>
        {pages.map(pg => (
          <Button
            key={pg}
            variant={safePostPage === pg ? 'primary' : 'outline-secondary'}
            size="sm"
            onClick={() => setPostPage(pg)}
            className="py-0 px-2"
            style={{ minWidth: '30px', fontSize: '0.8rem' }}
          >{pg}</Button>
        ))}
        <Button
          variant="outline-secondary"
          size="sm"
          disabled={safePostPage === totalPostPages}
          onClick={() => setPostPage(p => Math.min(totalPostPages, p + 1))}
          className="py-0 px-2"
          style={{ minWidth: '28px' }}
        >›</Button>
      </div>
    );
  };

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      size="lg"
      title={t('forum.move_posts_title')}
      footer={
        <>
          <Button
            variant="link"
            onClick={onHide}
            className="text-decoration-none text-muted"
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {submitting
              ? t('forum.move_posts_moving')
              : t('forum.move_posts_btn').replace('{n}', selectedPostIds.size)
            }
          </Button>
        </>
      }
    >
      {/* ── Post list section ──────────────────────────────────────────────── */}
      <div className="mb-4">
        <div className="d-flex align-items-center justify-content-between mb-2">
          <div className="fw-semibold small">
            {t('forum.move_posts_select_heading')}
            {selectedPostIds.size > 0 && (
              <Badge bg="primary" className="ms-2" style={{ fontSize: '0.7rem' }}>
                {selectedPostIds.size}
              </Badge>
            )}
          </div>
          {posts.length > 0 && (
            <Button
              variant="link"
              size="sm"
              className="text-decoration-none p-0"
              style={{ fontSize: '0.8rem' }}
              onClick={toggleAllOnPage}
            >
              {allPageSelected
                ? t('forum.move_posts_deselect_page')
                : t('forum.move_posts_select_page')
              }
            </Button>
          )}
        </div>

        <div
          className="border rounded move-posts-list"
          style={{ maxHeight: '350px', overflowY: 'auto' }}
        >
          {posts.length === 0 ? (
            <div className="p-3 text-muted text-center small">
              {t('forum.move_posts_no_posts')}
            </div>
          ) : (
            posts.map((post, i) => {
              const globalIndex = startIndex + i;
              const isFirst    = post.id === firstPostId;
              const isSelected = selectedPostIds.has(post.id);
              const preview    = stripBBCode(post.content);

              return (
                <div
                  key={post.id}
                  className={`move-post-row d-flex align-items-start gap-2 px-3 py-2${isSelected ? ' move-post-row--selected' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => togglePost(post.id)}
                >
                  {/* Checkbox */}
                  <div style={{ marginTop: '2px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    <Form.Check
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => togglePost(post.id)}
                      id={`move-post-check-${post.id}`}
                    />
                  </div>

                  {/* Post number */}
                  <div
                    className="text-muted fw-semibold flex-shrink-0"
                    style={{ fontSize: '0.78rem', minWidth: '36px', paddingTop: '2px' }}
                  >
                    #{globalIndex}
                  </div>

                  {/* Content preview */}
                  <div className="flex-grow-1 overflow-hidden">
                    <div className="d-flex align-items-baseline gap-2 flex-wrap">
                      <span className="fw-semibold" style={{ fontSize: '0.82rem' }}>
                        {post.author_name}
                      </span>
                      {isFirst && (
                        <span className="text-warning fw-semibold" style={{ fontSize: '0.72rem' }}>
                          {t('forum.move_posts_first_post_warn')}
                        </span>
                      )}
                    </div>
                    <div
                      className="text-muted"
                      style={{
                        fontSize: '0.76rem',
                        lineHeight: '1.35',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {preview || '—'}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Target selection section ───────────────────────────────────────── */}
      <div>
        <div className="fw-semibold small mb-2">
          {t('forum.move_posts_target_heading')}
        </div>

        {/* Forum select */}
        <Form.Select
          value={targetCategoryId}
          onChange={e => handleCategoryChange(e.target.value)}
          className="mb-2"
          aria-label={t('forum.move_posts_select_forum')}
        >
          <option value="">{t('forum.move_posts_select_forum')}</option>
          {groupsWithCats.map(group => (
            <optgroup key={group.id} label={resolveField(group.title, lang)}>
              {categories
                .filter(cat => cat.group_id === group.id)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map(cat => (
                  <option key={cat.id} value={cat.id}>
                    {resolveField(cat.title, lang)}
                  </option>
                ))}
            </optgroup>
          ))}
          {uncategorizedCats.length > 0 && (
            <optgroup label={t('forum.move_posts_uncategorized')}>
              {uncategorizedCats.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {resolveField(cat.title, lang)}
                </option>
              ))}
            </optgroup>
          )}
        </Form.Select>

        {/* Topic select */}
        <Form.Select
          value={targetTopicId}
          onChange={e => setTargetTopicId(e.target.value)}
          disabled={!targetCategoryId || loadingTopics || topics.length === 0}
          aria-label={t('forum.move_posts_select_topic')}
        >
          <option value="">{topicPlaceholder}</option>
          {topics.map(topic => (
            <option key={topic.id} value={topic.id}>
              {topic.title}
            </option>
          ))}
        </Form.Select>
      </div>
    </ForumModal>
  );
};

export default MovePostsModal;
