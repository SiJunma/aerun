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
  lang,
  t
}, ref) => {
  const replyEditorRef = React.useRef(null);

  // Spectator mode / no permission
  if (!hasPermission(PERMISSIONS.POST_REPLY, { category })) {
    if (user && profile?.role !== 'pending' && profile?.role !== 'banned') {
      return (
        <section className="topic-reply-notice" ref={ref}>
          <span className="topic-reply-notice__text">
            {t?.('forum.spectator_mode') || 'Spectator mode'}
          </span>
        </section>
      );
    }
    return null;
  }

  // Topic post limit reached
  if (topic.posts_count >= (settings?.maxPostsPerTopic ?? 1000)) {
    return (
      <section className="topic-reply" ref={ref}>
        <div className="topic-reply__card">
          <div className="topic-reply-notice__stack">
              <div className="topic-reply-notice__icon">
                <Lock size={32} />
              </div>
              <h4 className="topic-reply-notice__title">
                {lang === 'ru' ? 'Тема закрыта' : 'Topic Closed'}
              </h4>
              <p className="topic-reply-notice__text">
                {lang === 'ru'
                  ? `В теме достигнут лимит сообщений (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}). Новые ответы более не принимаются.`
                  : `The message limit (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}) has been reached for this topic. New replies are no longer accepted.`}
              </p>
            </div>
        </div>
      </section>
    );
  }

  // Topic locked
  if (topic.is_locked && !hasPermission(PERMISSIONS.CLOSE_TOPICS)) {
    return (
      <section
        className="topic-reply-notice"
        ref={ref}
      >
        <div className="topic-reply-notice__stack">
          <MessageSquareOff size={48} />
        </div>
        <h5 className="topic-reply-notice__title">
          {t?.('forum.topic_locked') || 'Topic Locked'}
        </h5>
        <p className="topic-reply-notice__text">
          {t?.('forum.topic_locked_desc') || 'This topic is locked. You cannot reply.'}
        </p>
      </section>
    );
  }

  return (
    <section
      className="topic-reply"
      ref={ref}
      id="topic-reply"
    >
      <div className="topic-reply__card">
        <div className="topic-reply__header reply-header">
          <h5 className="topic-reply__title">{t?.('forum.create_post') || 'Reply'}</h5>
        </div>
        <div className="topic-reply__body">
          <form onSubmit={handleReply} className="reply-form">
            {!user && (
              <div className="topic-reply__field">
                <label className="topic-reply__label" htmlFor="guestNickname">
                  {lang === 'ru' ? 'Ваш никнейм' : 'Your Nickname'} <span className="topic-reply__required">*</span>
                </label>
                <input
                  id="guestNickname"
                  type="text"
                  placeholder={lang === 'ru' ? 'Введите имя...' : 'Enter your name...'}
                  value={guestNickname}
                  onChange={(e) => setGuestNickname(e.target.value)}
                  required
                  className="topic-reply__input"
                />
              </div>
            )}

            <div className="topic-reply__mask-row">
              {user && settings?.enableCharacters !== false && hasPermission(PERMISSIONS.USE_MASKS, { category }) && (
                <details className="topic-reply__mask">
                  <summary className="topic-btn topic-btn--accent">
                    <User size={16} />
                    <span className="topic-reply__mask-text">
                      {selectedCharacterId
                        ? `${t?.('forum.post_as_character') || 'Character'}: ${characters.find(c => c.id === selectedCharacterId)?.name || '...'}`
                        : `${t?.('forum.post_as_user') || 'User'}: ${profile?.nickname || profile?.email?.split('@')[0]}`
                      }
                    </span>
                  </summary>
                  <div className="topic-reply__mask-menu">
                    <button
                      type="button"
                      className={`topic-reply__mask-item ${selectedCharacterId === '' ? 'is-active' : ''}`}
                      onClick={() => {
                        setSelectedCharacterId('');
                        if (user && setLastSelectedMask) setLastSelectedMask('');
                      }}
                    >
                      {t?.('forum.post_as_user') || 'User'}: {profile?.nickname || profile?.email?.split('@')[0]}
                    </button>
                    {characters.length > 0 && <hr className="topic-reply__mask-divider" />}
                    {characters.map(char => (
                      <button
                        type="button"
                        key={char.id}
                        className={`topic-reply__mask-item ${selectedCharacterId === char.id ? 'is-active' : ''}`}
                        onClick={() => {
                          setSelectedCharacterId(char.id);
                          if (user && setLastSelectedMask) setLastSelectedMask(char.id);
                        }}
                      >
                        {t?.('forum.post_as_character') || 'Character'}: {char.name}
                      </button>
                    ))}
                  </div>
                </details>
              )}

              <button
                type="button"
                className={`topic-btn topic-btn--accent ${(user && hasPermission(PERMISSIONS.USE_MASKS, { category })) ? '' : 'topic-reply__hotkeys'}`}
                onClick={() => replyEditorRef.current?.openHotkeysModal()}
                title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
              >
                <Keyboard size={18} />
                <span className="topic-reply__hotkeys-label">{lang === 'ru' ? 'Справка' : 'Help'}</span>
              </button>
            </div>

            <div className="topic-reply__field reply-editor">
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

            <div className="topic-reply__actions reply-actions">
              {user && !hasDraft && (
                <button
                  type="button"
                  className="topic-btn topic-btn--secondary"
                  disabled={submitting || draftSaving || !replyContent?.trim()}
                  onClick={handleSaveDraft}
                >
                  <FilePen size={14} />
                  {draftSaving ? t?.('forum.draft_saving') || 'Saving...' : t?.('forum.draft_save') || 'Save Draft'}
                </button>
              )}
              <button type="submit" className="topic-btn topic-btn--primary topic-reply__submit reply-submit" disabled={submitting}>
                {submitting
                  ? t?.('forum.posting') || 'Posting...'
                  : t?.('forum.create_post') || 'Submit Reply'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
});

TopicReplyComposer.displayName = 'TopicReplyComposer';

export default TopicReplyComposer;
