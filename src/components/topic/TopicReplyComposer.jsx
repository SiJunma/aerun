import React from 'react';
import { User, Keyboard, FilePen, Lock, MessageSquareOff } from 'lucide-react';
import RichEditor from '../common/RichEditor';
import MaskPicker from './MaskPicker';
import Button from '../common/Button';

/**
 * TopicReplyComposer: Reply composer card including character/mask selection,
 * rich text editing, draft saving, dice roller and spectator/locked notices.
 */
export const TopicReplyComposer = React.forwardRef(({
  topic,
  category,
  user,
  profile,
  settings,
  characters,
  selectedCharacterId,
  setSelectedCharacterId,
  setLastSelectedMask,
  replyContent,
  setReplyContent,
  guestNickname,
  setGuestNickname,
  submitting,
  draftSaving,
  hasDraft,
  handleReply,
  handleSaveDraft,
  hasPermission,
  PERMISSIONS,
  computedMaxChars,
  t
}, ref) => {
  const replyEditorRef = React.useRef(null);

  // Spectator mode / no permission
  if (!hasPermission(PERMISSIONS.POST_REPLY, { category })) {
    if (user && profile?.role !== 'pending' && profile?.role !== 'banned') {
      return (
        <div className="topic-reply-notice" ref={ref}>
          <div className="topic-reply-notice__stack">
            <div className="topic-reply-notice__icon">
              <MessageSquareOff size={48} />
            </div>
            <h4 className="topic-reply-notice__title">
              {t?.('forum.spectator_mode') || 'Spectator mode'}
            </h4>
          </div>
        </div>
      );
    }
    return null;
  }

  // Topic post limit reached
  if (topic.posts_count >= (settings?.maxPostsPerTopic ?? 1000)) {
    return (
      <div className="topic-reply-notice" ref={ref}>
        <div className="topic-reply-notice__stack">
          <div className="topic-reply-notice__icon topic-reply-notice__icon--danger">
            <Lock size={32} />
          </div>
          <h4 className="topic-reply-notice__title">
            {t('forum.topic_closed')}
          </h4>
          <p className="topic-reply-notice__text">
            {t('forum.topic_post_limit', { max: settings?.maxPostsPerTopic ?? 1000, limit: settings?.maxPostsPerTopic ?? 1000 })}
          </p>
        </div>
      </div>
    );
  }

  // Topic locked
  if (topic.is_locked && !hasPermission(PERMISSIONS.CLOSE_TOPICS)) {
    return (
      <div className="topic-reply-notice" ref={ref}>
        <div className="topic-reply-notice__stack">
          <div className="topic-reply-notice__icon">
            <MessageSquareOff size={48} className="opacity-25" />
          </div>
          <h4 className="topic-reply-notice__title">
            {t?.('forum.topic_locked') || 'Topic Locked'}
          </h4>
          <p className="topic-reply-notice__text">
            {t?.('forum.topic_locked_desc') || 'This topic is locked. You cannot reply.'}
          </p>
        </div>
      </div>
    );
  }

  const canUseMasks = user && hasPermission(PERMISSIONS.USE_MASKS, { category }) && (settings?.enableCharacters !== false);

  return (
    <div className="mt-5" ref={ref} id="reply-composer-form">
      <div className="topic-reply__card">
        <div className="topic-reply__header">
          <h5 className="topic-reply__title">{t?.('forum.create_post') || 'Reply'}</h5>
        </div>
        <div className="topic-reply__body">
          <form onSubmit={handleReply}>
            {!user && (
              <div className="topic-reply__field">
                <label className="topic-reply__label" htmlFor="guest-nickname">
                  {t?.('forum.guest_nickname_label') || 'Nickname'}
                </label>
                <input
                  type="text"
                  id="guest-nickname"
                  className="topic-reply__input"
                  value={guestNickname}
                  onChange={(e) => setGuestNickname(e.target.value)}
                  maxLength={30}
                  required
                />
              </div>
            )}
            <div className="topic-reply__field topic-reply__mask-row">
              {canUseMasks && (
                <MaskPicker
                  value={selectedCharacterId}
                  onChange={setSelectedCharacterId}
                  characters={characters}
                  profile={profile}
                  user={user}
                  setLastSelectedMask={setLastSelectedMask}
                  t={t}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => replyEditorRef.current?.openHotkeysModal()}
                title={t('forum.hotkeys')}
                leftIcon={<Keyboard size={18} />}
                aria-label={t('forum.hotkeys')}
              />
            </div>

            <div className="topic-reply__field">
              <RichEditor
                ref={replyEditorRef}
                id="reply-editor"
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder={t?.('forum.reply_placeholder') || 'Type your reply here...'}
                minHeight="210px"
                rows={6}
                maxLength={computedMaxChars}
                showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                isEdit={false}
                hideHotkeysButton={true}
                onSubmit={() => handleReply()}
              />
            </div>

            <div className="topic-reply__actions">
              {user && !hasDraft && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={submitting || draftSaving || !replyContent?.trim()}
                  onClick={handleSaveDraft}
                  leftIcon={<FilePen size={14} />}
                >
                  {draftSaving ? t?.('forum.draft_saving') || 'Saving...' : t?.('forum.draft_save') || 'Save Draft'}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={submitting}
              >
                {submitting
                  ? t?.('forum.posting') || 'Posting...'
                  : t?.('forum.create_post') || 'Submit Reply'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
});

TopicReplyComposer.displayName = 'TopicReplyComposer';

export default TopicReplyComposer;
