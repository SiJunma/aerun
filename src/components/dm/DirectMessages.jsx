import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Image, Badge, Spinner } from 'react-bootstrap';
import { Shield, Send, ArrowLeft, MessageCircle, Lock, Dices } from 'lucide-react';
import { Link } from 'react-router-dom';
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
} from '../../api/dms';
import { subscribeToUser } from '../../api/forum';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
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
  const { profile, hasPermission } = useAuth();
  const { showToast } = useToast();
  const myUid = profile?.uid;

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

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

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
    });
    // Mark as read when opening
    markDmRead(activeChatId, myUid).catch(() => {});
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
    const peerInfo = {
      uid: peerUid,
      name: conv.participantNames?.[peerUid] || 'User',
      avatar: conv.participantAvatars?.[peerUid] || '',
    };
    setActivePeer(peerInfo);
    setActiveChatId(conv.id);
    markDmRead(conv.id, myUid).catch(() => {});
  };

  // ── Send message ─────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!messageText.trim() || !activeChatId || !activePeer) return;
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
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return format(d, 'd MMM, HH:mm', { locale: lang === 'ru' ? ru : enUS });
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return format(d, 'd MMM', { locale: lang === 'ru' ? ru : enUS });
  };

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
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)', minHeight: '500px', overflow: 'hidden' }}
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
            ) : messages.length === 0 ? (
              <div className="text-center py-5 text-muted" style={{ fontSize: '1rem' }}>
                <MessageCircle size={32} className="mb-2 opacity-25" />
                <p className="mb-0">{t('dm.empty_chat')}</p>
              </div>
            ) : (
              <div className="d-flex flex-column">
                {messages.length >= messageLimit && (
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
                {messages.map((msg, index) => {
                  const isMe = msg.sender_uid === myUid;
                  const allConversationRolls = messages.reduce((acc, m) => ({ ...acc, ...(m.rolls || {}) }), {});

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
                        className="px-3 py-2 rounded-3"
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
                        <div><BBCode rolls={allConversationRolls}>{msg.text}</BBCode></div>
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
          <div className="dm-editor-col">
            <div className="flex-grow-1">
              <RichEditor
                id="dm-reply-editor"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder={t('dm.placeholder')}
                minHeight="120px"
                maxLength={2000}
                showDice={hasPermission && hasPermission(PERMISSIONS.USE_DICE)}
                hideDiceType={true}
                isEdit={false}
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
        ) : conversations.length === 0 ? (
          <div className="text-center py-5 text-muted">
            <MessageCircle size={40} className="mb-3 opacity-25" />
            <p className="mb-0">{t('dm.no_conversations')}</p>
          </div>
        ) : (
          <div className="d-flex flex-column gap-2">
            {conversations.map((conv) => {
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
