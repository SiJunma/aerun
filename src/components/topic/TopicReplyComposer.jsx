import React from 'react';
import { Card, Form, Button, Dropdown } from 'react-bootstrap';
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
    if (user && profile?.role_id !== 'pending' && profile?.role_id !== 'banned') {
      return (
        <div className="mt-5 p-4 text-center text-muted border rounded" ref={ref}>
          <span className="opacity-75">
            {t?.('forum.spectator_mode') || 'Spectator mode'}
          </span>
        </div>
      );
    }
    return null;
  }

  // Topic post limit reached
  if (topic.posts_count >= (settings?.maxPostsPerTopic ?? 1000)) {
    return (
      <div className="mt-5" ref={ref}>
        <Card className="shadow-sm border-0 bg-card overflow-hidden">
          <Card.Body className="p-4 text-center">
            <div className="d-flex flex-column align-items-center py-2">
              <div className="bg-light rounded-circle p-3 mb-3" style={{ color: 'var(--role-banned)' }}>
                <Lock size={32} />
              </div>
              <h4 className="fw-bold mb-2">
                {lang === 'ru' ? 'Тема закрыта' : 'Topic Closed'}
              </h4>
              <p className="text-muted mb-0 mx-auto" style={{ maxWidth: '400px' }}>
                {lang === 'ru'
                  ? `В теме достигнут лимит сообщений (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}). Новые ответы более не принимаются.`
                  : `The message limit (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}) has been reached for this topic. New replies are no longer accepted.`}
              </p>
            </div>
          </Card.Body>
        </Card>
      </div>
    );
  }

  // Topic locked
  if (topic.is_locked && !hasPermission(PERMISSIONS.CLOSE_TOPICS)) {
    return (
      <div
        className="mt-5 p-4 text-center text-muted rounded"
        style={{ backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)', opacity: 0.75 }}
        ref={ref}
      >
        <div className="mb-3">
          <MessageSquareOff size={48} className="opacity-25" />
        </div>
        <h5 className="mb-2">
          {t?.('forum.topic_locked') || 'Topic Locked'}
        </h5>
        <p className="small mb-0 opacity-75">
          {t?.('forum.topic_locked_desc') || 'This topic is locked. You cannot reply.'}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5" ref={ref} id="reply-composer-form">
      <Card className="shadow-sm border-0 bg-card">
        <Card.Header className="bg-dark text-white py-3">
          <h5 className="mb-0">{t?.('forum.create_post') || 'Reply'}</h5>
        </Card.Header>
        <Card.Body className="p-3 p-md-4">
          <Form onSubmit={handleReply}>
            {!user && (
              <Form.Group className="mb-3" controlId="guestNickname">
                <Form.Label className="fw-semibold small">
                  {lang === 'ru' ? 'Ваш никнейм' : 'Your Nickname'} <span className="text-danger">*</span>
                </Form.Label>
                <Form.Control
                  type="text"
                  placeholder={lang === 'ru' ? 'Введите имя...' : 'Enter your name...'}
                  value={guestNickname}
                  onChange={(e) => setGuestNickname(e.target.value)}
                  required
                  className="w-auto"
                  style={{ minWidth: '250px' }}
                />
              </Form.Group>
            )}

            <div className="d-flex align-items-center justify-content-between mb-2">
              {user && settings?.enableCharacters !== false && hasPermission(PERMISSIONS.USE_MASKS, { category }) && (
                <Dropdown className="w-auto">
                  <Dropdown.Toggle
                    variant="outline-management"
                    className="d-flex align-items-center gap-2 custom-select-toggle"
                  >
                    <User size={16} />
                    <span className="text-truncate" style={{ maxWidth: '250px' }}>
                      {selectedCharacterId
                        ? `${t?.('forum.post_as_character') || 'Character'}: ${characters.find(c => c.id === selectedCharacterId)?.name || '...'}`
                        : `${t?.('forum.post_as_user') || 'User'}: ${profile?.nickname || profile?.email?.split('@')[0]}`
                      }
                    </span>
                  </Dropdown.Toggle>
                  <Dropdown.Menu className="shadow-sm border-0 custom-select-menu">
                    <Dropdown.Item
                      active={selectedCharacterId === ''}
                      onClick={() => {
                        setSelectedCharacterId('');
                        if (user && setLastSelectedMask) setLastSelectedMask('');
                      }}
                    >
                      {t?.('forum.post_as_user') || 'User'}: {profile?.nickname || profile?.email?.split('@')[0]}
                    </Dropdown.Item>
                    {characters.length > 0 && <Dropdown.Divider />}
                    {characters.map(char => (
                      <Dropdown.Item
                        key={char.id}
                        active={selectedCharacterId === char.id}
                        onClick={() => {
                          setSelectedCharacterId(char.id);
                          if (user && setLastSelectedMask) setLastSelectedMask(char.id);
                        }}
                      >
                        {t?.('forum.post_as_character') || 'Character'}: {char.name}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              )}

              <Button
                variant="outline-management"
                className={`ms-auto d-none d-md-flex align-items-center gap-2 ${!(user && hasPermission(PERMISSIONS.USE_MASKS, { category })) ? 'mb-2' : ''}`}
                onClick={() => replyEditorRef.current?.openHotkeysModal()}
                title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
              >
                <Keyboard size={18} />
                <span className="d-none d-md-inline small">{lang === 'ru' ? 'Справка' : 'Help'}</span>
              </Button>
            </div>

            <Form.Group className="mb-3">
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
            </Form.Group>

            <div className="mt-4 d-flex justify-content-end gap-2">
              {user && !hasDraft && (
                <Button
                  variant="outline-secondary"
                  type="button"
                  disabled={submitting || draftSaving || !replyContent?.trim()}
                  onClick={handleSaveDraft}
                >
                  <FilePen size={14} className="me-1" />
                  {draftSaving ? t?.('forum.draft_saving') || 'Saving...' : t?.('forum.draft_save') || 'Save Draft'}
                </Button>
              )}
              <Button variant="primary" type="submit" className="px-4" disabled={submitting}>
                {submitting
                  ? t?.('forum.posting') || 'Posting...'
                  : t?.('forum.create_post') || 'Submit Reply'}
              </Button>
            </div>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
});

TopicReplyComposer.displayName = 'TopicReplyComposer';

export default TopicReplyComposer;
