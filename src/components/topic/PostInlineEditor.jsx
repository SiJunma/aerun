import React, { useRef } from 'react';
import { Form, Button, Dropdown } from 'react-bootstrap';
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
  t,
}) => {
  const editorRef = useRef(null);
  const canUseMasks = user && hasPermission?.(PERMISSIONS.USE_MASKS, { category });
  const canUseDice = hasPermission?.(PERMISSIONS.USE_DICE, { category });

  return (
    <div className="pb-3">
      {isFirstPost && !isDraft && (
        <div className="mb-3">
          <Form.Group className="mb-2">
            <Form.Label className="fw-semibold small">
              {t('forum.topic_title_label')}
            </Form.Label>
            <Form.Control
              type="text"
              value={editTopicTitle}
              onChange={(e) => setEditTopicTitle?.(e.target.value)}
              maxLength={100}
              required
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label className="fw-semibold small">
              {t('forum.topic_description_label')}
            </Form.Label>
            <Form.Control
              type="text"
              value={editTopicDescription}
              onChange={(e) => setEditTopicDescription?.(e.target.value)}
              maxLength={200}
              placeholder={t('forum.short_description_placeholder')}
            />
          </Form.Group>
          {setEditPinFirstPost && (
            <Form.Check
              type="checkbox"
              id="editPinFirstPost"
              label={t('forum.pin_first_post')}
              checked={editPinFirstPost}
              onChange={(e) => setEditPinFirstPost(e.target.checked)}
              className="mt-2"
            />
          )}
        </div>
      )}

      <div className="mb-2">
        <div className="d-flex align-items-center justify-content-between mb-2">
          {/* Mask re-filing is the AUTHOR's decision: the server ignores the
              character_id of a non-author edit, so the picker is hidden for
              moderated edits of other members' posts. */}
          {canUseMasks && canChangeMask && (
            <Dropdown className="w-auto">
              <Dropdown.Toggle
                variant="outline-management"
                size="sm"
                className="d-flex align-items-center gap-2 custom-select-toggle"
              >
                <User size={14} />
                <span className="text-truncate" style={{ maxWidth: '200px' }}>
                  {editCharacterId
                    ? `${t('forum.post_as_character')}: ${characters.find((c) => c.id === editCharacterId)?.name || '...'}`
                    : `${t('forum.post_as_user')}: ${profile?.nickname || profile?.email?.split('@')[0] || 'User'}`}
                </span>
              </Dropdown.Toggle>
              <Dropdown.Menu className="shadow-sm border-0 custom-select-menu">
                <Dropdown.Item
                  active={editCharacterId === ''}
                  onClick={() => setEditCharacterId?.('')}
                >
                  {t('forum.post_as_user')}: {profile?.nickname || profile?.email?.split('@')[0] || 'User'}
                </Dropdown.Item>
                {characters.length > 0 && <Dropdown.Divider />}
                {characters.map((char) => (
                  <Dropdown.Item
                    key={char.id}
                    active={editCharacterId === char.id}
                    onClick={() => setEditCharacterId?.(char.id)}
                  >
                    {t('forum.post_as_character')}: {char.name}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          )}

          <Button
            variant="outline-management"
            size="sm"
            className="ms-auto d-none d-md-flex align-items-center"
            onClick={() => editorRef.current?.openHotkeysModal()}
            title={t('forum.hotkeys')}
          >
            <Keyboard size={16} />
          </Button>
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

      <div className="d-flex gap-2">
        <Button
          size="sm"
          variant={isDraft ? 'outline-secondary' : 'primary'}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving
            ? t('common.saving')
            : isDraft
            ? t('forum.draft_update_btn')
            : t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};

export default PostInlineEditor;
