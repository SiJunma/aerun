import React from 'react';
import ConfirmModal from '../common/ConfirmModal';
import ForumModal from '../common/ForumModal';
import MoveTopicsModal from '../modals/MoveTopicsModal';
import MovePostsModal from '../modals/MovePostsModal';
import PostVotersModal from '../common/PostVotersModal';
import Timestamp from '../common/Timestamp';
import Button from '../common/Button';

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
  setRepValue,
  repComment,
  setRepComment,
  reputationStyle,
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
            ? t('forum.delete_topic_title')
            : t('forum.delete_post_title')
        }
        message={
          isFirstPostDeleting
            ? t('forum.delete_topic_message')
            : t('forum.delete_post_confirm')
        }
        confirmText={t?.('common.delete') || 'Delete'}
        cancelText={t?.('common.cancel') || 'Cancel'}
      />

      {/* Delete Topic Modal */}
      <ConfirmModal
        show={showDeleteTopicModal}
        onHide={onCancelDeleteTopic}
        onConfirm={onConfirmDeleteTopic}
        title={t('forum.delete_topic_title')}
        message={t('forum.delete_topic_message')}
        confirmText={t('forum.delete_topic_confirm')}
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
        onConfirm={onConfirmMovePosts}
        posts={posts}
        indexOfFirstItem={indexOfFirstItem}
        topicId={topicId}
      />

      {/* Reputation Vote Modal — restored from main: the vote value badge,
          the explanation and the comment field. The Sprint A migration had
          replaced it with a bare ConfirmModal, dropping all three. */}
      <ForumModal
        show={showRepModal}
        onHide={onCancelRepVote}
        size="md"
        title={t('forum.rep_vote_title')}
        footer={
          <>
            <Button variant="secondary" onClick={onCancelRepVote}>
              {t?.('common.cancel') || 'Cancel'}
            </Button>
            <Button variant="primary" onClick={onConfirmRepVote} disabled={submittingRep}>
              {submittingRep ? t('common.loading') : t('forum.rep_vote_confirm')}
            </Button>
          </>
        }
      >
        <div className="topic-text-center topic-mb-3">
          {/* Vote direction: the forum setting decides whether minuses exist
              at all (ProfilePage gates its − button the same way). In
              positive-only mode there is no choice — the vote is +1. */}
          {reputationStyle !== 'positive_only' && (
            <div className="rep-vote-toggle topic-mb-3" role="group">
              <button
                type="button"
                className={`rep-vote-toggle__btn rep-vote-toggle__btn--plus${repValue > 0 ? ' rep-vote-toggle__btn--active' : ''}`}
                onClick={() => setRepValue(1)}
                disabled={submittingRep}
                aria-pressed={repValue > 0}
              >
                +
              </button>
              <button
                type="button"
                className={`rep-vote-toggle__btn rep-vote-toggle__btn--minus${repValue < 0 ? ' rep-vote-toggle__btn--active' : ''}`}
                onClick={() => setRepValue(-1)}
                disabled={submittingRep}
                aria-pressed={repValue < 0}
              >
                −
              </button>
            </div>
          )}
          <div className="topic-text-sm topic-text-muted topic-mt-2">
            {t('forum.rep_vote_explanation')}
          </div>
        </div>
        <div>
          <div className="topic-text-sm topic-text-muted topic-mb-2">{t('profile.rep_add_comment')}</div>
          <textarea
            className="topic-textarea"
            rows={3}
            value={repComment}
            onChange={(e) => setRepComment(e.target.value)}
            placeholder={t('forum.vote_comment_placeholder')}
          />
        </div>
      </ForumModal>

      {/* Vote Info Modal */}
      <ForumModal
        show={showVoteInfoModal}
        onHide={onCancelVoteInfo}
        size="md"
        title={t('forum.vote_info_title')}
      >
        {selectedVote && (
          <div className="vote-info-modal">
            <div className="topic-flex-between-start topic-mb-3">
              <div>
                <div className="topic-text-bold">{t('forum.your_vote')}</div>
                <span className={`topic-badge topic-badge--${selectedVote.value > 0 ? 'success' : 'danger'} topic-text-sm topic-mt-1`}>
                  {selectedVote.value > 0 ? `+${selectedVote.value}` : selectedVote.value}
                </span>
              </div>
              <div className="topic-text-center">
                <div className="topic-text-sm topic-text-muted">{t('forum.vote_date')}</div>
                <div className="topic-text-bold">
                  <Timestamp date={selectedVote.created_at} />
                </div>
              </div>
            </div>

            <div>
              <div className="topic-flex-between topic-mb-2">
                <div className="topic-text-sm topic-text-muted">{t('forum.vote_comment')}</div>
                {(selectedVote.voter_id === currentUserId || !selectedVote.voter_id) && !isEditingRepComment && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingRepComment(selectedVote.comment || '');
                      setIsEditingRepComment(true);
                    }}
                  >
                    {selectedVote.comment ? t('forum.vote_edit') : t('forum.vote_add')}
                  </Button>
                )}
              </div>

              {isEditingRepComment ? (
                <div className="modal-inner-card">
                  <textarea
                    className="topic-textarea topic-mb-2"
                    rows={2}
                    value={editingRepComment}
                    onChange={(e) => setEditingRepComment(e.target.value)}
                    placeholder={t('forum.vote_comment_placeholder')}
                  />
                  <div className="topic-flex-end topic-gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setIsEditingRepComment(false)}
                      disabled={savingRepComment}
                    >
                      {t?.('common.cancel') || 'Cancel'}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={onUpdateRepComment}
                      disabled={savingRepComment}
                    >
                      {savingRepComment ? t('common.loading') : t('forum.vote_save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="modal-inner-card min-h-60px">
                  {selectedVote.comment || <span className="topic-opacity-50 topic-italic">{t('forum.vote_no_comment')}</span>}
                </div>
              )}
            </div>

            <div className="topic-text-sm topic-text-muted topic-opacity-75 topic-italic topic-text-center topic-mt-2">
              {t('forum.vote_contributed')}
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
