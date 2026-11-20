import React, { useRef } from 'react';
import { User, Keyboard } from 'lucide-react';
import RichEditor from '../common/RichEditor';
import MaskPicker from './MaskPicker';

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
  t,
}) => {
  const editorRef = useRef(null);
  const canUseMasks = user && hasPermission?.(PERMISSIONS.USE_MASKS, { category });
  const canUseDice = hasPermission?.(PERMISSIONS.USE_DICE, { category });

  return (
    <div className="topic-post-editor topic-post-editor--with-spacing">
      {isFirstPost && !isDraft && (
        <div className="topic-post-editor__field">
          <div className="topic-post-editor__field-row">
            <label className="topic-post-editor__label">
              {t('forum.topic_title_label')}
            </label>
            <input
              type="text"
              className="topic-post-editor__input"
              value={editTopicTitle}
              onChange={(e) => setEditTopicTitle?.(e.target.value)}
              maxLength={100}
              required
            />
          </div>
          <div className="topic-post-editor__field-row">
            <label className="topic-post-editor__label">
              {t('forum.topic_description_label')}
            </label>
            <input
              type="text"
              className="topic-post-editor__input"
              value={editTopicDescription}
              onChange={(e) => setEditTopicDescription?.(e.target.value)}
              maxLength={200}
              placeholder={t('forum.short_description_placeholder')}
            />
          </div>
          {setEditPinFirstPost && (
            <div className="topic-post-editor__pin">
              <input
                type="checkbox"
                id="editPinFirstPost"
                className="topic-post-editor__checkbox"
                checked={editPinFirstPost}
                onChange={(e) => setEditPinFirstPost(e.target.checked)}
              />
              <label htmlFor="editPinFirstPost">
                {t('forum.pin_first_post')}
              </label>
            </div>
          )}
        </div>
      )}

      <div className="topic-post-editor__field">
        <div className="topic-post-editor__field-row">
          {/* Mask re-filing is the AUTHOR's decision: the server ignores the
              character_id of a non-author edit, so the picker is hidden for
              moderated edits of other members' posts. */}
          {canUseMasks && canChangeMask && (
            <MaskPicker
              value={editCharacterId}
              onChange={setEditCharacterId}
              characters={characters}
              profile={profile}
              user={user}
              setLastSelectedMask={null} // Not available in inline editor context
              t={t}
              className="topic-mask-picker--inline"
            />
          )}

          <button
            type="button"
            className="topic-btn topic-btn--accent topic-btn--hotkeys"
            onClick={() => editorRef.current?.openHotkeysModal()}
            title={t('forum.hotkeys')}
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
          className={`topic-btn topic-btn--${isDraft ? 'secondary' : 'primary'} topic-btn-sm`}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving
            ? t('common.saving')
            : isDraft
            ? t('forum.draft_update_btn')
            : t('common.save')}
        </button>
        <button
          type="button"
          className="topic-btn topic-btn--secondary topic-btn-sm"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
};

export default PostInlineEditor;
