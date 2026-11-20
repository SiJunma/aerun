import React from 'react';
import { User, Keyboard, FilePen, Lock, MessageSquareOff } from 'lucide-react';
import RichEditor from '../common/RichEditor';

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
                <div className="topic-reply__mask-wrap">
                  <label className="topic-reply__label" htmlFor="reply-mask-select">
                    {t?.('forum.post_as_label') || 'Post as'}
                  </label>
                  <select
                    id="reply-mask-select"
                    className="topic-reply__mask-select"
                    value={selectedCharacterId}
                    onChange={(e) => {
                      setSelectedCharacterId(e.target.value);
                      if (user && setLastSelectedMask) setLastSelectedMask(e.target.value);
                    }}
                  >
                    <option value="">
                      {t?.('forum.post_as_user') || 'User'}: {profile?.nickname || profile?.email?.split('@')[0]}
                    </option>
                    {characters.length > 0 && characters.map(char => (
                      <option key={char.id} value={char.id}>
                        {t?.('forum.post_as_character') || 'Character'}: {char.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button
                type="button"
                className="topic-btn topic-btn--accent topic-btn--hotkeys"
                onClick={() => replyEditorRef.current?.openHotkeysModal()}
                title={t('forum.hotkeys')}
              >
                <Keyboard size={18} />
                <span>{t('forum.help')}</span>
              </button>
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
                <button
                  type="button"
                  className="topic-btn topic-btn--secondary"
                  disabled={submitting || draftSaving || !replyContent?.trim()}
                  onClick={handleSaveDraft}
                >
                  <FilePen size={14} className="me-1" />
                  {draftSaving ? t?.('forum.draft_saving') || 'Saving...' : t?.('forum.draft_save') || 'Save Draft'}
                </button>
              )}
              <button
                type="submit"
                className="topic-btn topic-btn--primary topic-reply__submit"
                disabled={submitting}
              >
                {submitting
                  ? t?.('forum.posting') || 'Posting...'
                  : t?.('forum.create_post') || 'Submit Reply'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
});

TopicReplyComposer.displayName = 'TopicReplyComposer';

export default TopicReplyComposer;
