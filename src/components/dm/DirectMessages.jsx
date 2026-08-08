import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Image, Badge, Spinner } from 'react-bootstrap';
import { Shield, Send, ArrowLeft, MessageCircle, Lock, Dices, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { useToast } from '../../contexts/ToastProvider';
import RichEditor from '../common/RichEditor';
import BBCode from '../common/BBCode';
import {
  getOrCreateConversation,
  subscribeToDmList,
  subscribeToDmMessages,
  sendDmMessage,
  markDmRead,
  deleteConversation,
} from '../../api/dms';
import { subscribeToUser } from '../../api/auth-resources';
import Timestamp from '../common/Timestamp';
import { PERMISSIONS } from '../../constants/permissions';

/**
 * DirectMessages component
 * 
 * Props:
 *   mode: 'inbox' | 'chat'
 *   targetUid: string (for 'chat' mode — the other participant's UID)
 *   targetProfile: object (optional, preloaded profile of target)
 */
const DirectMessages = ({ mode = 'inbox', targetUid, targetProfile: initialTargetProfile }) => {
  const { t, lang } = useI18n();
  const { profile, settings, hasPermission } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const myUid = profile?.uid;

  const MAX_CHARS = settings?.maxCharsPerPost ?? 15000;
  const computedMaxChars = MAX_CHARS > 0 ? MAX_CHARS : undefined;

  // ── Inbox state ──────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(true);

  // ── Chat state ───────────────────────────────────────────────────────────
  const [activeChatId, setActiveChatId] = useState(null); // conversationId
  const [activePeer, setActivePeer] = useState(null);     // { uid, name, avatar }
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [targetProfile, setTargetProfile] = useState(initialTargetProfile || null);
  const [messageLimit, setMessageLimit] = useState(50);
  const [peerStatus, setPeerStatus] = useState('active'); // 'active', 'deleted', 'banned'

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // ── Track peer status ───────────────────────────────────────────────────
  useEffect(() => {
    if (!activePeer || !activePeer.uid) return;
    const unsub = subscribeToUser(activePeer.uid, (data) => {
      if (!data) {
        setPeerStatus('deleted');
      } else if (data.role_id === 'banned') {
        setPeerStatus('banned');
      } else {
        setPeerStatus('active');
      }
    });
    return () => unsub();
  }, [activePeer]);

  // ── Load target profile if not provided ─────────────────────────────────
  useEffect(() => {
    if (!targetUid || initialTargetProfile) return;
    const unsub = subscribeToUser(targetUid, (data) => setTargetProfile(data));
    return () => unsub && unsub();
  }, [targetUid, initialTargetProfile]);

  // ── Subscribe to inbox ───────────────────────────────────────────────────
  useEffect(() => {
    if (!myUid) return;
    setLoadingConvs(true);
    const unsub = subscribeToDmList(myUid, (convs) => {
      setConversations(convs);
      setLoadingConvs(false);
    });
    return () => unsub();
  }, [myUid]);

  // ── Auto-open chat when in 'chat' mode ──────────────────────────────────
  useEffect(() => {
    if (mode !== 'chat' || !targetUid || !myUid || !targetProfile) return;
    openChat(targetUid, {
      uid: targetUid,
      name: targetProfile?.nickname || 'User',
      avatar: targetProfile?.avatar_url || '',
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetUid, myUid, targetProfile]);

  // ── Reset state when returning to inbox ──────────────────────────────────
  useEffect(() => {
    if (mode === 'inbox') {
      setActiveChatId(null);
      setActivePeer(null);
      setMessages([]);
    }
  }, [mode]);

  // ── Subscribe to messages when a chat is open ────────────────────────────
  useEffect(() => {
    setMessageLimit(50);
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId) return;
    if (messages.length === 0) setLoadingChat(true);
    const unsub = subscribeToDmMessages(activeChatId, messageLimit, (msgs) => {
      setMessages(msgs);
      setLoadingChat(false);
      // Mark as read every time new messages arrive while the chat is open
      markDmRead(activeChatId, myUid).catch(() => {});
    });
    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, myUid, messageLimit]);

  // ── Auto-scroll to bottom ────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Open a chat ──────────────────────────────────────────────────────────
  const openChat = async (peerUid, peerInfo) => {
    if (!myUid) return;
    setActivePeer(peerInfo);
    try {
      const convId = await getOrCreateConversation(myUid, peerUid, profile, targetProfile || peerInfo);
      setActiveChatId(convId);
    } catch (err) {
      console.error('[openChat]', err);
      showToast(lang === 'ru' ? 'Ошибка открытия диалога' : 'Failed to open conversation', 'danger');
    }
  };

  // ── Open chat from inbox click ───────────────────────────────────────────
  const openInboxConversation = (conv) => {
    const peerUid = conv.participants.find(p => p !== myUid);
    navigate(`/messages/${peerUid}`);
  };

  // ── Send message ─────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!messageText.trim() || !activeChatId || !activePeer) return;

    if (computedMaxChars && messageText.length > computedMaxChars) {
      showToast(
        lang === 'ru'
          ? `Cообщение превышает лимит в ${computedMaxChars} символов`
          : `Message exceeds the ${computedMaxChars} character limit`,
        'danger'
      );
      return;
    }

    setSending(true);
    try {
      await sendDmMessage(activeChatId, myUid, messageText, activePeer.uid);
      setMessageText('');
      inputRef.current?.focus();
    } catch (err) {
      console.error('[handleSend]', err);
      showToast(lang === 'ru' ? 'Ошибка отправки сообщения' : 'Failed to send message', 'danger');
    } finally {
      setSending(false);
    }
  };


  const formatTs = (ts) => {
    if (!ts) return '';
    return <Timestamp date={ts} />;
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    return <Timestamp date={ts} />;
  };

  // ── Deletion handler ─────────────────────────────────────────────────────
  const handleDeleteConversation = async (convId, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const confirmMsg = lang === 'ru' 
      ? 'Вы уверены, что хотите безвозвратно удалить этот диалог у себя?' 
      : 'Are you sure you want to permanently delete this conversation for yourself?';
    if (!window.confirm(confirmMsg)) return;

    try {
      await deleteConversation(convId, myUid);
      showToast(lang === 'ru' ? 'Диалог удален' : 'Conversation deleted', 'success');
      if (activeChatId === convId) {
        setActiveChatId(null);
        setActivePeer(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('[handleDeleteConversation]', err);
      showToast(lang === 'ru' ? 'Ошибка удаления' : 'Delete error', 'danger');
    }
  };

  // ── Derived State (Filtering) ────────────────────────────────────────────
  const myClearTime = conversations.find(c => c.id === activeChatId)?.clearedAt?.[myUid];

  const visibleMessages = messages.filter(msg => {
    if (!myClearTime) return true;
    if (!msg.timestamp) return true; // Optimistic local messages
    return msg.timestamp.toMillis() > myClearTime.toMillis();
  });

  const visibleConversations = conversations.filter(c => {
    const clearTime = c.clearedAt?.[myUid];
    if (!clearTime) return true;
    if (!c.lastTimestamp) return false;
    return c.lastTimestamp.toMillis() > clearTime.toMillis();
  });

  // ── Privacy notice ───────────────────────────────────────────────────────
  const PrivacyNotice = () => (
    <div
      className="d-flex align-items-center gap-2 px-3 py-2 mb-3 rounded"
      style={{
        background: 'var(--block-bg)',
        border: '1px solid var(--border-color)',
        fontSize: '0.78rem',
      }}
    >
      <Shield size={14} className="text-primary flex-shrink-0" />
      <span className="text-muted">{t('dm.privacy_notice')}</span>
    </div>
  );

  // ── Chat View ─────────────────────────────────────────────────────────────
  if (activeChatId && activePeer) {
    return (
      <Card
        className="shadow-sm border-0 bg-card dm-fullscreen-card"
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)', minHeight: '500px' }}
      >
        {/* Header */}
        <Card.Header className="py-2 d-flex align-items-center gap-3" style={{ flexShrink: 0, background: 'var(--nav-bg)' }}>
          <Button
            as={mode === 'chat' ? Link : 'button'}
            to={mode === 'chat' ? '/messages' : undefined}
            variant="link"
            size="sm"
            className="text-decoration-none p-0 me-1 d-flex align-items-center"
            style={{ color: '#ffffff', border: 'none', boxShadow: 'none' }}
            onClick={mode === 'inbox' ? () => { setActiveChatId(null); setActivePeer(null); setMessages([]); } : undefined}
          >
            <ArrowLeft size={20} color="#ffffff" />
          </Button>
          <Image
            src={activePeer.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(activePeer.name)}&background=random`}
            roundedCircle
            style={{ width: '40px', height: '40px', objectFit: 'cover', flexShrink: 0, border: '1px solid rgba(255,255,255,0.2)' }}
            onError={(e) => { e.target.onerror = null; e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(activePeer.name)}&background=666&color=fff`; }}
          />
          <div>
            <Link
              to={`/profile/${activePeer.uid}`}
              className="fw-bold text-decoration-none"
              style={{ color: '#ffffff', fontSize: '1.05rem', display: 'block', lineHeight: '1.2' }}
            >
              {activePeer.name}
            </Link>
              <div
              className="d-flex align-items-center gap-1"
              style={{ fontSize: '0.875rem', opacity: 0.8, color: '#ffffff' }}
            >
              <Lock size={12} color="#ffffff" />
              <span>{t('dm.encryption_badge')}</span>
            </div>
          </div>
          <Button
            variant="link"
            size="sm"
            className="ms-auto text-decoration-none p-1"
            style={{ color: '#ffffff', opacity: 0.8 }}
            onClick={(e) => handleDeleteConversation(activeChatId, e)}
            title={lang === 'ru' ? 'Удалить переписку' : 'Delete conversation'}
          >
            <Trash2 size={20} />
          </Button>
        </Card.Header>

        {/* Two-column body: messages left, editor right — stacks vertically on mobile (see index.css) */}
        <div className="dm-chat-body">

          {/* Left: scrollable message feed */}
          <div className="dm-messages-col">
            <PrivacyNotice />
            {loadingChat ? (
              <div className="text-center py-5 text-muted">
                <Spinner animation="border" size="sm" />
              </div>
            ) : visibleMessages.length === 0 ? (
              <div className="text-center py-5 text-muted" style={{ fontSize: '1rem' }}>
                <MessageCircle size={32} className="mb-2 opacity-25" />
                <p className="mb-0">{t('dm.empty_chat')}</p>
              </div>
            ) : (
              <div className="d-flex flex-column">
                {visibleMessages.length >= messageLimit && (
                  <div className="text-center mb-3">
                    <Button 
                      variant="link" 
                      size="sm" 
                      className="text-muted text-decoration-none" 
                      onClick={() => setMessageLimit(prev => prev + 50)}
                    >
                      {lang === 'ru' ? 'Загрузить предыдущие сообщения' : 'Load previous messages'}
                    </Button>
                  </div>
                )}
                {visibleMessages.map((msg, index) => {
                  const isMe = msg.sender_uid === myUid;
                  const allConversationRolls = visibleMessages.reduce((acc, m) => ({ ...acc, ...(m.rolls || {}) }), {});

                  return (
                    <div
                      key={msg.id || index}
                      className={`d-flex mb-2 ${isMe ? 'justify-content-end' : 'justify-content-start'}`}
                    >
                      {!isMe && (
                        <Image
                          src={activePeer?.avatar || '/default-avatar.png'}
                          roundedCircle
                          className="me-2"
                          style={{ width: '30px', height: '30px', objectFit: 'cover' }}
                        />
                      )}
                      <div
                        className="px-3 py-2 rounded-3 dm-chat-bubble"
                        style={{
                          maxWidth: '85%',
                          background: isMe ? 'var(--primary-color)' : 'var(--block-bg)',
                          border: isMe ? 'none' : '1px solid var(--border-color)',
                          color: isMe ? 'var(--bg-color)' : 'var(--text-color)',
                          fontSize: '1rem',
                          wordBreak: 'break-word',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
                        }}
                      >
                        <div className="w-100"><BBCode rolls={allConversationRolls} isDM={true}>{msg.text}</BBCode></div>
                        <div
                          className="text-end mt-1"
                          style={{ fontSize: '0.875rem', opacity: 0.6 }}
                        >
                          {formatTs(msg.timestamp)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Right: editor column */}
          {peerStatus !== 'active' ? (
            <div className="dm-editor-col d-flex align-items-center justify-content-center">
              <div className="text-center p-4 border rounded" style={{ background: 'var(--block-bg)', borderColor: 'var(--border-color)', width: '100%' }}>
                <Lock size={32} className="mb-3 text-muted opacity-50" />
                <p className="text-muted mb-0 fw-medium">
                  {peerStatus === 'deleted'
                    ? (lang === 'ru' ? 'Аккаунт пользователя удален. Отправка сообщений недоступна.' : 'User account deleted. Sending messages is disabled.')
                    : (lang === 'ru' ? 'Пользователь заблокирован. Отправка сообщений недоступна.' : 'User is banned. Sending messages is disabled.')}
                </p>
              </div>
            </div>
          ) : (
            <div className="dm-editor-col">
              <div className="flex-grow-1">
                <RichEditor
                  id="dm-reply-editor"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder={t('dm.placeholder')}
                  minHeight="120px"
                  maxLength={computedMaxChars}
                  showDice={hasPermission && hasPermission(PERMISSIONS.USE_DICE)}
                  hideDiceType={true}
                  isEdit={false}
                  showHide={false}
                  smilesDropDirection="start"
                  smilesFullWidth={false}
                />
              </div>
              <div className="d-flex justify-content-end">
                <Button
                  variant="primary"
                  onClick={handleSend}
                  disabled={sending || !messageText.trim()}
                  className="d-flex align-items-center gap-2"
                >
                  {sending ? <Spinner size="sm" animation="border" /> : <Send size={15} />}
                  {t('dm.send_button')}
                </Button>
              </div>
            </div>
          )}

        </div>
      </Card>
    );
  }

  // ── Inbox View ────────────────────────────────────────────────────────────
  return (
    <Card className="shadow-sm border-0 bg-card dm-fullscreen-card" style={{ minHeight: 'calc(100vh - 140px)' }}>
      <Card.Header className="py-3 d-flex align-items-center gap-2">
        <MessageCircle size={18} />
        <h5 className="mb-0">{t('dm.inbox')}</h5>
      </Card.Header>
      <Card.Body className="p-3">
        <PrivacyNotice />

        {loadingConvs ? (
          <div className="text-center py-5">
            <Spinner animation="border" size="sm" />
          </div>
        ) : visibleConversations.length === 0 ? (
          <div className="text-center py-5 text-muted">
            <MessageCircle size={40} className="mb-3 opacity-25" />
            <p className="mb-0">{t('dm.no_conversations')}</p>
          </div>
        ) : (
          <div className="d-flex flex-column gap-2">
            {visibleConversations.map((conv) => {
              const peerUid = conv.participants?.find(p => p !== myUid);
              const peerName = conv.participantNames?.[peerUid] || 'User';
              const peerAvatar = conv.participantAvatars?.[peerUid] || '';
              const unreadCount = conv.unread?.[myUid] || 0;
              return (
                <div
                  key={conv.id}
                  className="d-flex align-items-center gap-3 p-2 rounded cursor-pointer"
                  style={{ cursor: 'pointer', transition: 'background 0.15s' }}
                  onClick={() => openInboxConversation(conv)}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--block-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  role="button"
                >
                  <div className="position-relative">
                    <Image
                      src={peerAvatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(peerName)}&background=random`}
                      roundedCircle
                      style={{ width: '44px', height: '44px', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { e.target.onerror = null; e.target.src = `https://ui-avatars.com/api/?name=U&background=666&color=fff`; }}
                    />
                    {unreadCount > 0 && (
                      <Badge
                        bg="danger"
                        pill
                        className="position-absolute"
                        style={{ top: '-4px', right: '-4px', fontSize: '0.75rem', minWidth: '18px' }}
                      >
                        {unreadCount}
                      </Badge>
                    )}
                  </div>
                  <div className="flex-grow-1 min-w-0">
                    <div className="d-flex justify-content-between align-items-center">
                      <span className={`fw-${unreadCount > 0 ? 'bold' : 'semibold'} text-truncate`} style={{ maxWidth: '180px', fontSize: '1rem' }}>
                        {peerName}
                      </span>
                      <span className="text-muted" style={{ fontSize: '0.875rem', flexShrink: 0 }}>
                        {formatDate(conv.lastTimestamp)}
                      </span>
                    </div>
                    <p className={`mb-0 text-truncate small ${unreadCount > 0 ? '' : 'text-muted'}`} style={{ maxWidth: '240px', fontSize: '0.875rem' }}>
                      {conv.lastMessage || '…'}
                    </p>
                  </div>
                  <Button
                    variant="link"
                    className="text-muted p-2 mx-1 shadow-none dm-trash-btn"
                    style={{ opacity: 0.6 }}
                    onClick={(e) => handleDeleteConversation(conv.id, e)}
                    title={lang === 'ru' ? 'Удалить переписку' : 'Delete conversation'}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

export default DirectMessages;
