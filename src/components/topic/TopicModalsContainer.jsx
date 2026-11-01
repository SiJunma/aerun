import React from 'react';
import { Button, Badge, Form } from 'react-bootstrap';
import ConfirmModal from '../common/ConfirmModal';
import ForumModal from '../common/ForumModal';
import MoveTopicsModal from '../modals/MoveTopicsModal';
import MovePostsModal from '../modals/MovePostsModal';
import PostVotersModal from '../common/PostVotersModal';
import Timestamp from '../common/Timestamp';

/**
 * TopicModalsContainer: Encapsulates all modal dialogs for topic & post actions
 * (Delete Post, Delete Topic, Move Topic, Move Posts, Rep Vote, Vote Info, Post Voters).
 */
export const TopicModalsContainer = ({
  // Delete post
  deletingPost,
  onCancelDeletePost,
  onConfirmDeletePost,

  // Delete topic
  showDeleteTopicModal,
  onCancelDeleteTopic,
  onConfirmDeleteTopic,

  // Move topic
  showMoveModal,
  onCancelMoveTopic,
  onConfirmMoveTopic,
  topicCategoryId,

  // Move posts
  showMovePostsModal,
  onCancelMovePosts,
  onConfirmMovePosts,
  posts,
  indexOfFirstItem,
  topicId,

  // Reputation vote
  showRepModal,
  onCancelRepVote,
  onConfirmRepVote,
  repValue,
  repComment,
  setRepComment,
  submittingRep,

  // Vote info
  showVoteInfoModal,
  onCancelVoteInfo,
  selectedVote,
  currentUserId,
  isEditingRepComment,
  setIsEditingRepComment,
  editingRepComment,
  setEditingRepComment,
  savingRepComment,
  onUpdateRepComment,

  // Post voters
  showPostVotersModal,
  onCancelPostVoters,
  selectedPostForVoters,

  lang,
  t
}) => {
  // Deleting the topic's FIRST post deletes the WHOLE topic (the server
  // re-files the delete through the topic route), so the confirmation must
  // warn about that — same swap the legacy monolith made in its modals.
  const isFirstPostDeleting =
    !!deletingPost &&
    !deletingPost.is_draft &&
    indexOfFirstItem === 0 &&
    posts?.length > 0 &&
    posts[0]?.id === deletingPost.id;
  return (
    <>
      {/* Delete Post Modal — deleting the topic's FIRST post deletes the
          whole topic, so the title/message swap to the legacy topic warning
          for that case (legacy monolith, modals section). */}
      <ConfirmModal
        show={!!deletingPost}
        onHide={onCancelDeletePost}
        onConfirm={onConfirmDeletePost}
        title={
          isFirstPostDeleting
            ? (lang === 'ru' ? 'Удалить тему?' : 'Delete topic?')
            : (t?.('forum.delete_post_title') || 'Delete Post')
        }
        message={
          isFirstPostDeleting
            ? (lang === 'ru'
                ? 'Внимание: удаление первого сообщения приведет к удалению всей темы целиком. Это действие необратимо.'
                : 'Warning: deleting the first post will delete the entire topic. This action cannot be undone.')
            : (t?.('forum.delete_post_confirm') || 'Are you sure you want to delete this post?')
        }
        confirmText={t?.('common.delete') || 'Delete'}
        cancelText={t?.('common.cancel') || 'Cancel'}
      />

      {/* Delete Topic Modal */}
      <ConfirmModal
        show={showDeleteTopicModal}
        onHide={onCancelDeleteTopic}
        onConfirm={onConfirmDeleteTopic}
        title={lang === 'ru' ? 'Удалить тему целиком?' : 'Delete entire topic?'}
        message={
          lang === 'ru'
            ? 'Это действие удалит саму тему и все сообщения в ней навсегда. Вы уверены?'
            : 'This action will permanently delete the topic and all its posts. Are you sure?'
        }
        confirmText={lang === 'ru' ? 'Удалить полностью' : 'Delete permanently'}
        cancelText={t?.('common.cancel') || 'Cancel'}
      />

      {/* Move Topic Modal */}
      <MoveTopicsModal
        show={showMoveModal}
        onHide={onCancelMoveTopic}
        onConfirm={onConfirmMoveTopic}
        topicCount={1}
        excludeCategoryId={topicCategoryId}
      />

      {/* Move Posts Modal */}
      <MovePostsModal
        show={showMovePostsModal}
        onHide={onCancelMovePosts}
        posts={posts || []}
        startIndex={(indexOfFirstItem || 0) + 1}
        // "First post" here means the TOPIC's first post. Moving it does NOT
        // delete the topic (owner ruling 2026-11-01): the next earliest post
        // becomes the opener — hence the label, not a scary warning. That is
        // page-1 index 0 ONLY: on pages 2+ posts[0] is an ordinary reply and
        // must not carry the mark. Same gate the delete-post check above
        // applies (indexOfFirstItem === 0); on pages 2+ the first post is
        // absent from this list anyway (when pinned it renders as the pinned
        // card, which the modal does not list).
        firstPostId={indexOfFirstItem === 0 ? posts?.[0]?.id : null}
        currentTopicId={topicId}
        onConfirm={onConfirmMovePosts}
      />

      {/* Reputation Vote Modal */}
      <ForumModal
        show={showRepModal}
        onHide={onCancelRepVote}
        title={t?.('profile.rep_give') || 'Give Reputation'}
        footer={
          <>
            <Button variant="outline-secondary" onClick={onCancelRepVote}>
              {t?.('common.cancel') || 'Cancel'}
            </Button>
            <Button variant="primary" onClick={onConfirmRepVote} disabled={submittingRep}>
              {submittingRep ? t?.('common.loading') || 'Loading...' : t?.('common.confirm') || 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-center mb-4">
          <Badge bg={repValue > 0 ? 'success' : 'danger'} className="fs-3 px-4 py-2">
            {repValue > 0 ? `+${repValue}` : repValue}
          </Badge>
          <div className="mt-3 text-muted small px-3">
            {lang === 'ru'
              ? 'Этот голос изменит репутацию данного поста и будет зачислен в общую репутацию (карму) автора.'
              : "This vote will change the reputation of this post and contribute to the author's total reputation (karma)."}
          </div>
        </div>
        <Form.Group>
          <Form.Label className="fw-bold small">
            {lang === 'ru' ? 'Комментарий (опционально)' : 'Leave a comment (optional)'}
          </Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={repComment}
            onChange={(e) => setRepComment(e.target.value)}
            placeholder=""
            className="modal-section-themed"
          />
        </Form.Group>
      </ForumModal>

      {/* Vote Info Modal */}
      <ForumModal
        show={showVoteInfoModal}
        onHide={onCancelVoteInfo}
        title={lang === 'ru' ? 'Информация о вашем голосе' : 'Your Vote Information'}
        className="premium-modal shadow-lg"
        footer={
          <Button variant="outline-secondary" className="w-100" onClick={onCancelVoteInfo}>
            {t?.('common.close') || 'Close'}
          </Button>
        }
      >
        {selectedVote && (
          <div className="d-flex flex-column gap-3">
            <div className="d-flex justify-content-between align-items-center modal-inner-card p-3">
              <div>
                <div className="small text-muted">{lang === 'ru' ? 'Ваш голос' : 'Your vote'}</div>
                <Badge bg={selectedVote.value > 0 ? 'success' : 'danger'} className="fs-5 mt-1">
                  {selectedVote.value > 0 ? `+${selectedVote.value}` : selectedVote.value}
                </Badge>
              </div>
              <div className="text-end">
                <div className="small text-muted">{lang === 'ru' ? 'Дата' : 'Date'}</div>
                <div className="fw-bold">
                  <Timestamp date={selectedVote.created_at} />
                </div>
              </div>
            </div>

            <div>
              <div className="d-flex justify-content-between align-items-center mb-2">
                <div className="small text-muted">{lang === 'ru' ? 'Ваш комментарий' : 'Your comment'}</div>
                {(selectedVote.voter_id === currentUserId || !selectedVote.voter_id) && !isEditingRepComment && (
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 text-decoration-none small"
                    onClick={() => {
                      setEditingRepComment(selectedVote.comment || '');
                      setIsEditingRepComment(true);
                    }}
                  >
                    {selectedVote.comment ? (lang === 'ru' ? 'Изменить' : 'Edit') : (lang === 'ru' ? 'Добавить' : 'Add')}
                  </Button>
                )}
              </div>

              {isEditingRepComment ? (
                <div className="modal-inner-card p-3 border-start border-4 border-accent">
                  <Form.Control
                    as="textarea"
                    rows={2}
                    value={editingRepComment}
                    onChange={(e) => setEditingRepComment(e.target.value)}
                    placeholder={lang === 'ru' ? 'Введите комментарий...' : 'Enter your comment...'}
                    className="modal-section-themed mb-2"
                  />
                  <div className="d-flex justify-content-end gap-2">
                    <Button
                      variant="outline-secondary"
                      size="sm"
                      onClick={() => setIsEditingRepComment(false)}
                      disabled={savingRepComment}
                    >
                      {t?.('common.cancel') || 'Cancel'}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={onUpdateRepComment}
                      disabled={savingRepComment}
                    >
                      {savingRepComment ? t?.('common.loading') || 'Loading...' : (lang === 'ru' ? 'Сохранить' : 'Save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="p-3 modal-inner-card border-start border-4 border-accent" style={{ minHeight: '60px' }}>
                  {selectedVote.comment || (lang === 'ru' ? <span className="opacity-50 italic">Без комментария</span> : <span className="opacity-50 italic">No comment left</span>)}
                </div>
              )}
            </div>

            <div className="small text-muted opacity-75 italic text-center mt-2">
              {lang === 'ru'
                ? 'Этот голос зачислен автору поста.'
                : 'This vote has been contributed to the post author.'}
            </div>
          </div>
        )}
      </ForumModal>

      {/* Post Voters Modal */}
      <PostVotersModal
        show={showPostVotersModal}
        onHide={onCancelPostVoters}
        postId={selectedPostForVoters?.id}
        postNumber={selectedPostForVoters?.postNumber}
        lang={lang}
      />
    </>
  );
};

export default TopicModalsContainer;
