import React from 'react';
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
  _repValue,
  _repComment,
  _setRepComment,
  _submittingRep,

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

      {/* Reputation Vote Modal */}
      <ConfirmModal
        show={showRepModal}
        onHide={onCancelRepVote}
        onConfirm={onConfirmRepVote}
        title={t('forum.rep_vote_title')}
        message={t('forum.rep_vote_message')}
        confirmText={t('forum.rep_vote_confirm')}
        cancelText={t?.('common.cancel') || 'Cancel'}
      />

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
                  <button
                    type="button"
                    className="topic-btn topic-btn--link topic-text-sm"
                    onClick={() => {
                      setEditingRepComment(selectedVote.comment || '');
                      setIsEditingRepComment(true);
                    }}
                  >
                    {selectedVote.comment ? t('forum.vote_edit') : t('forum.vote_add')}
                  </button>
                )}
              </div>

              {isEditingRepComment ? (
                <div className="modal-inner-card">
                  <textarea
                    className="topic-textarea modal-section-themed topic-mb-2"
                    rows={2}
                    value={editingRepComment}
                    onChange={(e) => setEditingRepComment(e.target.value)}
                    placeholder={t('forum.vote_comment_placeholder')}
                  />
                  <div className="topic-flex-end topic-gap-2">
                    <button
                      type="button"
                      className="topic-btn topic-btn--secondary topic-btn-sm"
                      onClick={() => setIsEditingRepComment(false)}
                      disabled={savingRepComment}
                    >
                      {t?.('common.cancel') || 'Cancel'}
                    </button>
                    <button
                      type="button"
                      className="topic-btn topic-btn--primary topic-btn-sm"
                      onClick={onUpdateRepComment}
                      disabled={savingRepComment}
                    >
                      {savingRepComment ? t('common.loading') : t('forum.vote_save')}
                    </button>
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
