import React, { useRef } from 'react';
import { User, Keyboard } from 'lucide-react';
import RichEditor from '../common/RichEditor';

/**
 * PostInlineEditor: Inline editor for editing existing posts and drafts.
 * Supports topic title/description for the opening post, character mask selection,
 * rich formatting, dice roller, and keyboard shortcuts.
 */
export const PostInlineEditor = ({
  isFirstPost = false,
  isDraft = false,
  canChangeMask = true,
  editTopicTitle = '',
  setEditTopicTitle,
  editTopicDescription = '',
  setEditTopicDescription,
  editPinFirstPost = false,
  setEditPinFirstPost,
  editCharacterId = '',
  setEditCharacterId,
  characters = [],
  user,
  profile,
  editContent = '',
  setEditContent,
  computedMaxChars,
  hasPermission,
  PERMISSIONS,
  category,
  onSave,
  onCancel,
  isSaving = false,
  lang = 'ru',
  t,
}) => {
  const editorRef = useRef(null);
  const canUseMasks = user && hasPermission?.(PERMISSIONS.USE_MASKS, { category });
  const canUseDice = hasPermission?.(PERMISSIONS.USE_DICE, { category });

  return (
    <div className="topic-post-editor">
      {isFirstPost && !isDraft && (
        <div className="topic-post-editor__fields">
          <div className="topic-post-editor__field">
            <label className="topic-post-editor__label" htmlFor="editTopicTitle">
              {lang === 'ru' ? 'Название темы' : 'Topic Title'}
            </label>
            <input
              id="editTopicTitle"
              type="text"
              value={editTopicTitle}
              onChange={(e) => setEditTopicTitle?.(e.target.value)}
              maxLength={100}
              required
              className="topic-reply__input"
            />
          </div>
          <div className="topic-post-editor__field">
            <label className="topic-post-editor__label" htmlFor="editTopicDescription">
              {lang === 'ru' ? 'Описание темы' : 'Topic Description'}
            </label>
            <input
              id="editTopicDescription"
              type="text"
              value={editTopicDescription}
              onChange={(e) => setEditTopicDescription?.(e.target.value)}
              maxLength={200}
              placeholder={lang === 'ru' ? 'Краткое описание...' : 'Short description...'}
              className="topic-reply__input"
            />
          </div>
          {setEditPinFirstPost && (
            <label className="topic-post-editor__pin" htmlFor="editPinFirstPost">
              <input
                id="editPinFirstPost"
                type="checkbox"
                checked={editPinFirstPost}
                onChange={(e) => setEditPinFirstPost(e.target.checked)}
                className="topic-select-input"
              />
              <span>{t?.('forum.pin_first_post') || (lang === 'ru' ? 'Закрепить первое сообщение' : 'Pin first post')}</span>
            </label>
          )}
        </div>
      )}

      <div className="topic-post-editor__field">
        <div className="topic-post-editor__mask-row">
          {/* Mask re-filing is the AUTHOR's decision: the server ignores the
              character_id of a non-author edit, so the picker is hidden for
              moderated edits of other members' posts. */}
          {canUseMasks && canChangeMask && (
            <details className="topic-reply__mask">
              <summary className="topic-btn topic-btn--accent">
                <User size={14} />
                <span className="topic-post-editor__mask-text">
                  {editCharacterId
                    ? `${t?.('forum.post_as_character') || (lang === 'ru' ? 'От лица персонажа' : 'Post as character')}: ${characters.find((c) => c.id === editCharacterId)?.name || '...'}`
                    : `${t?.('forum.post_as_user') || (lang === 'ru' ? 'От своего имени' : 'Post as user')}: ${profile?.nickname || profile?.email?.split('@')[0] || 'User'}`}
                </span>
              </summary>
              <div className="topic-reply__mask-menu">
                <button
                  type="button"
                  className={`topic-reply__mask-item ${editCharacterId === '' ? 'is-active' : ''}`}
                  onClick={() => setEditCharacterId?.('')}
                >
                  {t?.('forum.post_as_user') || (lang === 'ru' ? 'От своего имени' : 'Post as user')}: {profile?.nickname || profile?.email?.split('@')[0] || 'User'}
                </button>
                {characters.length > 0 && <hr className="topic-reply__mask-divider" />}
                {characters.map((char) => (
                  <button
                    type="button"
                    key={char.id}
                    className={`topic-reply__mask-item ${editCharacterId === char.id ? 'is-active' : ''}`}
                    onClick={() => setEditCharacterId?.(char.id)}
                  >
                    {t?.('forum.post_as_character') || (lang === 'ru' ? 'От лица персонажа' : 'Post as character')}: {char.name}
                  </button>
                ))}
              </div>
            </details>
          )}

          <button
            type="button"
            className="topic-btn topic-btn--accent"
            onClick={() => editorRef.current?.openHotkeysModal()}
            title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
          >
            <Keyboard size={16} />
          </button>
        </div>

        <RichEditor
          ref={editorRef}
          id={isDraft ? 'draftEditContent' : 'editContent'}
          value={editContent}
          onChange={(e) => setEditContent?.(e.target.value)}
          rows={6}
          minHeight="210px"
          maxLength={computedMaxChars}
          autoFocus={true}
          showDice={canUseDice}
          isEdit={true}
          hideHotkeysButton={true}
          onSubmit={onSave}
        />
      </div>

      <div className="topic-post-editor__actions">
        <button
          type="button"
          className={`topic-btn ${isDraft ? 'topic-btn--secondary' : 'topic-btn--primary'}`}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving
            ? t?.('common.saving', {}, lang === 'ru' ? 'Сохранение...' : 'Saving...')
            : isDraft
            ? t?.('forum.draft_update_btn', {}, lang === 'ru' ? 'Обновить черновик' : 'Update draft')
            : t?.('common.save', {}, lang === 'ru' ? 'Сохранить' : 'Save')}
        </button>
        <button
          type="button"
          className="topic-btn topic-btn--secondary"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t?.('common.cancel') || (lang === 'ru' ? 'Отмена' : 'Cancel')}
        </button>
      </div>
    </div>
  );
};

export default PostInlineEditor;
