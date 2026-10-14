import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Card, Button, Image, Badge, Spinner, Form } from 'react-bootstrap';
import { Shield, Send, ArrowLeft, MessageCircle, Lock, Dices, Trash2, ChevronDown } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { useToast } from '../../contexts/ToastProvider';
import RichEditor from '../common/RichEditor';
import { resolveAvatarUrl } from '../../api/avatars';
import BBCode from '../common/BBCode';
import {
  getOrCreateConversation,
  subscribeToDmList,
  subscribeToDmMessages,
  fetchOlderDmMessages,
  sendDmMessage,
  editDmMessage,
  deleteDmMessage,
  refreshDmList,
  refreshDmMessages,
  markDmRead,
  subscribeToPeerCard,
  deleteConversation,
} from '../../api/dms';
import { createInFlight, newIdempotencyKey } from '../../utils/inflight';
import { playNotificationSound } from '../../utils/notificationSound';
import Timestamp from '../common/Timestamp';
import ErrorCard from '../common/ErrorCard';
import ConfirmModal from '../common/ConfirmModal';
import { PERMISSIONS } from '../../constants/permissions';
import { deletedDisplayName, placeholderAvatarUrl } from '../../utils/identity';

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
  const { profile, settings, hasPermission, setActiveDmConvId } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const myUid = profile?.uid;

  const MAX_CHARS = settings?.maxCharsPerPost ?? 15000;
  const computedMaxChars = MAX_CHARS > 0 ? MAX_CHARS : undefined;

  // ── Inbox state ──────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [inboxError, setInboxError] = useState(null);

  // ── Chat state ───────────────────────────────────────────────────────────
  const [activeChatId, setActiveChatId] = useState(null); // conversationId
  const [activePeer, setActivePeer] = useState(null);     // { uid, name, avatar }
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [targetProfile, setTargetProfile] = useState(initialTargetProfile || null);
  const [messageLimit, setMessageLimit] = useState(15);
  const [peerStatus, setPeerStatus] = useState('active'); // 'active', 'deleted', 'banned'

  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  const [deleteConfirmConvId, setDeleteConfirmConvId] = useState(null);

  const messagesEndRef = useRef(null);
  const editorRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const isLoadingOlderRef = useRef(false);
  const scrollPosBeforeRef = useRef({ scrollHeight: 0, scrollTop: 0 });
  const initialScrollDoneRef = useRef(false);
  const prevMessagesCountRef = useRef(0);
  const firstUnreadIdRef = useRef(null);
  // Highest message sequence already reported as read for this thread. See the
  // mark-read call in the poll callback for why this gates the write.
  const lastReadSeqRef = useRef(0);
  // Set once the member has walked backwards through history. After that the
  // server's has_more describes the newest page, not what is on screen, so it
  // must stop steering the button.
  const hasPrependedRef = useRef(false);
  const sentByMeRef = useRef(false); // flag to force scroll-to-bottom after sending own message
  // In-flight get-or-create per peer: chat mode's auto-open effect re-fires
  // when the peer card arrives (targetProfile flips from null to a card) and
  // React StrictMode double-invokes effects in dev, so two openChat calls for
  // the SAME peer can overlap. Both would miss in `known`, both would GET
  // peer → empty, and both would POST /dms — two identical conversations with
  // no console error. The guard makes the second caller join the first.
  const openChatInflightRef = useRef(new Map());
  // Peers already resolved to a conversation id this mount: a re-fire with the
  // same targetUid (peer card tick, remount) reuses instead of re-asking.
  const openChatDoneRef = useRef(new Map());

  const getScrollContainer = () => {
    return scrollContainerRef.current;
  };

  const checkIfAtBottom = useCallback((threshold = 90) => {
    const container = getScrollContainer();
    if (!container) return true;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    return dist <= threshold;
  }, []);

  const handleScroll = (e) => {
    const target = e?.currentTarget || getScrollContainer();
    if (!target) return;
    const dist = target.scrollHeight - target.scrollTop - target.clientHeight;
    const atBottom = dist <= 90;
    setShowScrollBottom(!atBottom);
    if (atBottom) {
      setUnreadBelowCount(0);
      firstUnreadIdRef.current = null;
    }
  };

  const scrollToUnreadOrBottom = () => {
    const container = getScrollContainer();
    if (!container) return;

    if (firstUnreadIdRef.current) {
      const el = document.getElementById(`dm-msg-${firstUnreadIdRef.current}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstUnreadIdRef.current = null;
        setUnreadBelowCount(0);
        return;
      }
    }

    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    setShowScrollBottom(false);
    setUnreadBelowCount(0);
    firstUnreadIdRef.current = null;
  };

  // ── The correspondent: ONE small read, shared by the header and the lock ────
  //
  // Both of these used to call `subscribeToUser`, which is the profile PAGE:
  // bio, birthday, occupation, contacts, counters and the member's `settings`.
  // Two effects, so opening a thread issued the same heavy read twice, and the
  // header only ever rendered a nickname and an avatar out of it.
  //
  // `subscribeToPeerCard` is that subset — nickname, avatar, status — off
  // /api/aerun/peers/{id}. One shared resource, so the header and the composer
  // lock cost ONE request between them, and a conversation left open all evening
  // re-reads four fields every two minutes rather than a whole profile.
  useEffect(() => {
    if (!activePeer?.uid) return;
    const unsub = subscribeToPeerCard(activePeer.uid, (card) => {
      if (!card) {
        setPeerStatus('deleted');
      } else if (card.status === 'banned') {
        setPeerStatus('banned');
      } else {
        setPeerStatus('active');
      }
    });
    return () => unsub();
  }, [activePeer?.uid]);

  // ── Load target profile if not provided ─────────────────────────────────
  //
  // The SAME resource as above, keyed by the same uid: chat mode opens with
  // `targetUid`, which then becomes `activePeer.uid`. Sharing them is what turns
  // two reads of one account into one — and before this was `subscribeToUser`,
  // so the duplicate was two reads of a member's full profile instead.
  useEffect(() => {
    if (!targetUid || initialTargetProfile) return;
    const unsub = subscribeToPeerCard(targetUid, (card) => setTargetProfile(card));
    return () => unsub();
  }, [targetUid, initialTargetProfile]);

  // ── Subscribe to inbox ───────────────────────────────────────────────────
  useEffect(() => {
    if (!myUid) return;
    setLoadingConvs(true);
    setInboxError(null);
    const unsub = subscribeToDmList(
      myUid,
      (convs) => {
        setConversations(convs);
        setLoadingConvs(false);
      },
      (err) => {
        setInboxError(err);
        setLoadingConvs(false);
      }
    );
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
      setChatError(null);
    }
  }, [mode]);

  // ── Register active chat in AuthProvider so Navbar can exclude it from unread badge ──
  useEffect(() => {
    setActiveDmConvId(activeChatId);
    return () => setActiveDmConvId(null);
  }, [activeChatId, setActiveDmConvId]);

  // ── Subscribe to messages when a chat is open (with local cache) ─────────
  useEffect(() => {
    if (!activeChatId || !myUid) return;
    
    setChatError(null);
    initialScrollDoneRef.current = false;
    prevMessagesCountRef.current = 0;
    setShowScrollBottom(false);
    setUnreadBelowCount(0);
    firstUnreadIdRef.current = null;
    // A new thread starts with nothing marked read, so its first tick writes
    // once and every tick after it stays quiet.
    lastReadSeqRef.current = 0;
    // The server's has_more is authoritative again for this new thread.
    hasPrependedRef.current = false;
    // Start empty and let the first read fill it.
    //
    // This used to hydrate from a localStorage cache first, up to 50 messages.
    // It was there for the Firestore era, when a cache kept a thread visible
    // while the realtime channel was slow to deliver. It is now the opposite of
    // what we want: the cache outlived a conversation's contents, so a thread
    // opened at what looked like the whole history while the server had been
    // asked for fifteen messages and had said so. Worse, messages can now be
    // EDITED and DELETED, so a cache is a copy of text that is no longer
    // necessarily true — the reader would be shown words their correspondent had
    // already withdrawn.
    //
    // Each session starts from the newest fifteen and walks backwards on demand.
    setMessages([]);
    setLoadingChat(true);

    setHasMoreOlder(true);
    setMessageLimit(15);

    // 1. Subscribe for updates; the first read delivers the newest page.
    const unsub = subscribeToDmMessages(
      activeChatId,
      messageLimit,
      (msgs) => {
        setMessages(prev => {
          // Detect new incoming message from the other participant
          if (prev.length > 0 && msgs.length > 0) {
            const latestNew = msgs[msgs.length - 1];
            const isFromPeer = latestNew && latestNew.sender_uid && latestNew.sender_uid !== myUid;
            const isNew = !prev.some(m => m.id === latestNew.id);
            if (isFromPeer && isNew && profile?.settings?.sound?.enabled !== false) {
              playNotificationSound(profile?.settings?.sound?.volume ?? 40);
            }
          }

          const map = new Map();
          prev.forEach(m => m.id && map.set(m.id, m));
          msgs.forEach(m => m.id && map.set(m.id, m));
          // sequence, not timestamp: two messages written in the same second
          // have equal timestamps, and a comparator that returns 0 for a tie
          // leaves their order up to the sort — which is how a thread ends up
          // reading out of order. sequence is dense and unique per conversation.
          const merged = Array.from(map.values()).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
          return merged;
        });
        setLoadingChat(false);
        // Mark read ONLY when there is something new to have read.
        //
        // This ran on every poll tick, and the thread polls every 5s, so an open
        // DM page wrote to the server 12 times a minute forever, to set a value
        // that was already correct. It was the single biggest contributor to the
        // request count on this page. The highest sequence seen from the peer is
        // the watermark: a tick that brings nothing newer does no write at all.
        const newest = msgs.length ? msgs[msgs.length - 1] : null;
        if (newest && newest.sequence > lastReadSeqRef.current) {
          lastReadSeqRef.current = newest.sequence;
          markDmRead(activeChatId, myUid).catch(() => {});
        }
      },
      (err) => {
        setChatError(err);
        setLoadingChat(false);
      },
      // The server's answer to "is there history older than this page?".
      //
      // It was ignored entirely, and hasMoreOlder was hard-coded to true on
      // every open, so a conversation with nothing older still showed a
      // "load older messages" button that did nothing when clicked.
      //
      // Only applied while the client has NOT walked backwards yet: once the
      // member has prepended older pages this flag describes the NEWEST page
      // and would keep re-arming the button they had just emptied.
      (hasMore) => {
        if (!hasPrependedRef.current) setHasMoreOlder(hasMore);
      }
    );

    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, myUid, messageLimit]);

  const handleLoadOlder = async () => {
    if (!activeChatId || loadingOlder || messages.length === 0) return;

    // Capture scroll container state before prepending older messages
    const container = getScrollContainer();
    scrollPosBeforeRef.current = {
      scrollHeight: container ? container.scrollHeight : 0,
      scrollTop: container ? container.scrollTop : 0
    };
    isLoadingOlderRef.current = true;

    setLoadingOlder(true);
    try {
      const oldestMsg = messages[0];
      // The cursor is the oldest message's SEQUENCE, not its timestamp: the
      // server pages on sequence, and two messages can share a timestamp.
      const olderMsgs = await fetchOlderDmMessages(activeChatId, oldestMsg?.sequence, 15);
      if (olderMsgs.length === 0) {
        setHasMoreOlder(false);
        isLoadingOlderRef.current = false;
      } else {
        // From here on the button is ours, not the server's.
        hasPrependedRef.current = true;
        setMessages(prev => {
          const map = new Map();
          olderMsgs.forEach(m => m.id && map.set(m.id, m));
          prev.forEach(m => m.id && map.set(m.id, m));
          // sequence is dense per conversation, so it orders the merged thread
          // exactly; timestamps can tie, and a tie sorted by timestamp is how a
          // conversation ended up reading out of order.
          const merged = Array.from(map.values()).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
          return merged;
        });
        // A short page means the beginning of the conversation has been reached.
        // Otherwise the server told us so on the page itself, which is the same
        // answer without guessing from a length.
        if (olderMsgs.length < 15) {
          setHasMoreOlder(false);
        }
      }
    } catch (err) {
      console.error('[handleLoadOlder err]', err);
      isLoadingOlderRef.current = false;
    } finally {
      setLoadingOlder(false);
    }
  };

  // ── Auto-scroll: messenger-style (initial load, on sending, or if already at bottom) ──
  useLayoutEffect(() => {
    const container = getScrollContainer();
    if (!container) return;

    if (isLoadingOlderRef.current) {
      // 1. Loading older messages: preserve scroll position
      const deltaHeight = container.scrollHeight - scrollPosBeforeRef.current.scrollHeight;
      container.scrollTop = scrollPosBeforeRef.current.scrollTop + deltaHeight;
      isLoadingOlderRef.current = false;
      const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBottom(dist > 90);
    } else if (!initialScrollDoneRef.current) {
      // 2. Initial load: immediately snap to bottom
      if (messages.length > 0) {
        container.scrollTop = container.scrollHeight;
        initialScrollDoneRef.current = true;
        setShowScrollBottom(false);
        setUnreadBelowCount(0);
        firstUnreadIdRef.current = null;
      }
    } else {
      // 3. New message added
      const prevCount = prevMessagesCountRef.current;
      const newCount = messages.length;
      const addedCount = newCount - prevCount;

      if (addedCount > 0) {
        const lastMsg = messages[messages.length - 1];
        const isFromMe = lastMsg?.sender_uid === myUid;
        const forcedByMe = sentByMeRef.current;
        const atBottom = checkIfAtBottom(150); // wider threshold for autoResize textarea

        if (isFromMe || forcedByMe || atBottom) {
          // Sent by me, forced, or user was at bottom: auto-scroll to bottom
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
          setShowScrollBottom(false);
          setUnreadBelowCount(0);
          firstUnreadIdRef.current = null;
          sentByMeRef.current = false;
        } else {
          // Scrolled up reading history and peer sent a message:
          // Keep user position, show floating button with new messages badge
          setShowScrollBottom(true);
          setUnreadBelowCount(prev => prev + addedCount);
          if (!firstUnreadIdRef.current) {
            firstUnreadIdRef.current = messages[prevCount]?.id || lastMsg?.id;
          }
        }
      }
    }
    prevMessagesCountRef.current = messages.length;
  }, [messages, myUid, checkIfAtBottom]);

  // ── Open a chat ──────────────────────────────────────────────────────────
  const openChat = async (peerUid, peerInfo) => {
    if (!myUid) return;
    setActivePeer(peerInfo);
    // Already resolved this mount: reuse, do not re-ask the server.
    const done = openChatDoneRef.current.get(peerUid);
    if (done) {
      setActiveChatId(done);
      return;
    }
    // An identical lookup is already running: join it instead of racing it.
    const inflight = openChatInflightRef.current.get(peerUid);
    if (inflight) {
      try {
        const convId = await inflight;
        setActiveChatId(convId);
      } catch (err) {
        console.error('[openChat]', err);
        showToast(lang === 'ru' ? 'Ошибка открытия диалога' : 'Failed to open conversation', 'danger');
      }
      return;
    }
    const pending = (async () => {
      // The inbox list is passed in so an existing thread is REUSED instead of a
      // duplicate being started — see getOrCreateConversation for why the lookup
      // cannot happen in the browser.
      const convId = await getOrCreateConversation(myUid, peerUid, profile, targetProfile || peerInfo, conversations);
      openChatDoneRef.current.set(peerUid, convId);
      return convId;
    })();
    openChatInflightRef.current.set(peerUid, pending);
    try {
      const convId = await pending;
      openChatInflightRef.current.delete(peerUid);
      setActiveChatId(convId);
    } catch (err) {
      openChatInflightRef.current.delete(peerUid);
      console.error('[openChat]', err);
      showToast(lang === 'ru' ? 'Ошибка открытия диалога' : 'Failed to open conversation', 'danger');
    }
  };

  // ── Open chat from inbox click ───────────────────────────────────────────
  const openInboxConversation = (conv) => {
    const peerUid = (conv.participants || []).find(p => p !== myUid);
    // A degenerate thread (peer_missing / a migration ghost) has no participant
    // to navigate to. Guard the read so the row never throws on undefined.find
    // and never navigates to /messages/undefined (bug M2); the trash button
    // still removes it.
    if (!peerUid) return;
    navigate(`/messages/${peerUid}`);
  };

  // ── Edit / delete a message you sent ───────────────────────────────────────
  // The server is the authority on both: only the sender may edit or delete,
  // and a tombstone cannot be edited. These are the UI affordances for that,
  // not a second copy of the rule — a staff account has no extra power here,
  // because private mail is not forum content.
  const [editingMsgId, setEditingMsgId] = useState(null);
  const [editingText, setEditingText] = useState('');

  const handleStartDmEdit = (msg) => {
    setEditingMsgId(msg.id);
    setEditingText(msg.text || '');
  };

  const handleCancelDmEdit = () => {
    setEditingMsgId(null);
    setEditingText('');
  };

  // Put the server's answer for one row straight into the thread.
  //
  // This is the whole fix for "I edited it and nothing happened". Both mutation
  // handlers used to await the request, throw the response away and show a
  // success toast, leaving the bubble to repaint itself — and it could not,
  // because the author is deliberately not signalled about their own change and
  // shared-poll removes its fallback timer as soon as ANY signal arrives. The
  // words on screen were only ever going to change if some unrelated poll tick
  // happened to land.
  //
  // REPLACE rather than merge: a tombstone comes back with no `text` key at all,
  // and spreading it over the old row would keep the very text that was just
  // withdrawn. Replacing also drops keys the server deliberately omits, which is
  // the whole contract of the tombstone payload.
  const applyMessageUpdate = (updated) => {
    if (!updated?.id) return;
    setMessages(prev => {
      if (!prev.some(m => m.id === updated.id)) return prev;
      return prev.map(m => (m.id === updated.id ? updated : m));
    });
  };

  const handleSaveDmEdit = async (msg) => {
    if (!editingText.trim()) return;
    try {
      const updated = await editDmMessage(msg.id, editingText);
      handleCancelDmEdit();
      if (updated) applyMessageUpdate(updated);
      // Converges the sidebar preview and the counters, which an edit moves.
      refreshDmMessages(activeChatId);
      showToast(lang === 'ru' ? 'Сообщение изменено' : 'Message edited');
    } catch (err) {
      console.error('[handleSaveDmEdit]', err);
      showToast(lang === 'ru' ? 'Не удалось изменить сообщение' : 'Failed to edit message', 'danger');
    }
  };

  const handleDeleteDm = async (msg) => {
    try {
      const tombstone = await deleteDmMessage(msg.id);
      handleCancelDmEdit();
      if (tombstone) applyMessageUpdate(tombstone);
      refreshDmMessages(activeChatId);
      showToast(
        lang === 'ru'
          ? 'Сообщение удалено. Оно остаётся видимым в переписке.'
          : 'Message deleted. It stays visible in the conversation.'
      );
    } catch (err) {
      console.error('[handleDeleteDm]', err);
      showToast(lang === 'ru' ? 'Не удалось удалить сообщение' : 'Failed to delete message', 'danger');
    }
  };

  // ── Send message ─────────────────────────────────────────────────────────
  // The in-flight latch is a REF, not the `sending` state above. React batches
  // state writes, so two clicks in the same tick both read `sending === false`
  // from the render closure and both post. A ref write is not batched.
  const sendInFlightRef = useRef(null);
  if (sendInFlightRef.current === null) {
    sendInFlightRef.current = createInFlight();
  }

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

    if (!sendInFlightRef.current.begin()) return;

    setSending(true);
    sentByMeRef.current = true; // flag to force scroll when the message arrives
    try {
      // ONE key per logical send, reused by anything that retries. Without it
      // sendApi mints a fresh random key per call, so a duplicate that escapes
      // the latch would be a genuinely second message.
      const sent = await sendDmMessage(activeChatId, myUid, messageText, activePeer.uid, newIdempotencyKey('dm'));
      setMessageText('');
      editorRef.current?.focus();

      // The server's answer is the ONLY thing that can paint the author's own
      // bubble: a `dm.post` signal is addressed to the other participants
      // (publishDMSignalToPeers excludes the caller), and shared-poll removes
      // the fallback timer as soon as realtime CONNECTS — no event required.
      // A send that discards the response leaves the words waiting for a tick
      // that is never coming, which is the reported "I pressed send and nothing
      // appeared until I reloaded" on EVERY conversation, not just cleared ones.
      // Merge by id rather than blindly append: the refreshed thread read below
      // may already have carried this row.
      if (sent?.id) {
        setMessages(prev => {
          if (prev.some(m => m.id === sent.id)) return prev;
          return [...prev, sent].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
        });
      }
      // Settle the thread read (sidebar preview, counters, has_more) now — the
      // same nudge edit and delete already give it.
      refreshDmMessages(activeChatId);
      // And the INBOX, which a send needs and edit/delete do not: the row moves
      // to the top, its preview changes, and for a conversation that was
      // CLEARED the row itself only comes back from the server once the new
      // message carries last_message_at past cleared_at. Without this the row
      // waits for a reload — the second half of the same report.
      refreshDmList(myUid);

      const container = getScrollContainer();
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    } catch (err) {
      console.error('[handleSend]', err);
      showToast(lang === 'ru' ? 'Ошибка отправки сообщения' : 'Failed to send message', 'danger');
    } finally {
      setSending(false);
      sendInFlightRef.current.end();
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
  const promptDeleteConversation = (convId, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setDeleteConfirmConvId(convId);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmConvId) return;
    const convId = deleteConfirmConvId;
    setDeleteConfirmConvId(null);

    // Optimistic: drop the row NOW so the member sees the delete land, then
    // converge with the server. Without this the row sat on screen until the
    // next 10s list tick (or a reload) — the exact shape of "deleted but
    // still there". On failure the refresh below restores the row.
    const previous = conversations;
    setConversations(prev => prev.filter(c => c.id !== convId));
    try {
      await deleteConversation(convId, myUid);
      refreshDmList(myUid);
      showToast(lang === 'ru' ? 'Диалог удален' : 'Conversation deleted', 'success');
      if (activeChatId === convId) {
        setActiveChatId(null);
        setActivePeer(null);
        setMessages([]);
        navigate('/messages');
      }
    } catch (err) {
      setConversations(previous);
      console.error('[handleDeleteConversation]', err);
      showToast(lang === 'ru' ? 'Ошибка удаления' : 'Delete error', 'danger');
    }
  };

  // ── Derived State (Filtering) ────────────────────────────────────────────
  // PocketBase datetimes arrive as "2026-09-11 04:32:07.134Z" — a space where
  // ISO wants a T. These two filters used to call `.toMillis()` on them, which
  // is the Firestore accessor the migration removed: it survives only on the
  // object type this data no longer is, so the first member to CLEAR a
  // conversation unmounted the whole page with a TypeError instead of a list.
  const toMillis = (value) => {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const parsed = new Date(String(value).replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  };

  const myClearTime = conversations.find(c => c.id === activeChatId)?.clearedAt?.[myUid];

  const visibleMessages = messages.filter(msg => {
    const clearMs = toMillis(myClearTime);
    if (clearMs === null) return true;
    const msgMs = toMillis(msg.timestamp);
    if (msgMs === null) return true; // Optimistic local messages
    return msgMs > clearMs;
  });

  const visibleConversations = conversations.filter(c => {
    const clearMs = toMillis(c.clearedAt?.[myUid]);
    if (clearMs === null) return true;
    const lastMs = toMillis(c.lastTimestamp);
    if (lastMs === null) return false;
    return lastMs > clearMs;
  });

  // ── Privacy notice ───────────────────────────────────────────────────────
  const PrivacyNotice = () => (
    <div
      className="d-flex align-items-start gap-2 px-3 py-2 mb-3 rounded"
      style={{
        background: 'var(--block-bg)',
        border: '1px solid var(--border-color)',
        fontSize: '0.78rem',
      }}
    >
      <Shield size={14} className="text-primary flex-shrink-0" style={{ marginTop: '0.15rem' }} />
      <span className="text-muted">{t('dm.privacy_notice')}</span>
    </div>
  );

  if (activeChatId && activePeer) {
    return (
      <>
        <Card
          className="shadow-sm border-0 bg-card dm-fullscreen-card"
          style={{ display: 'flex', flexDirection: 'column' }}
        >
        {/* Header */}
        <Card.Header className="py-1 px-3 d-flex align-items-center gap-2" style={{ flexShrink: 0, background: 'var(--nav-bg)', minHeight: '44px' }}>
          <Button
            as={mode === 'chat' ? Link : 'button'}
            to={mode === 'chat' ? '/messages' : undefined}
            variant="link"
            size="sm"
            className="text-decoration-none p-0 me-1 d-flex align-items-center"
            style={{ color: '#ffffff', border: 'none', boxShadow: 'none' }}
            onClick={mode === 'inbox' ? () => { setActiveChatId(null); setActivePeer(null); setMessages([]); } : undefined}
          >
            <ArrowLeft size={18} color="#ffffff" />
          </Button>
          <Image
            src={resolveAvatarUrl(activePeer.avatar) || placeholderAvatarUrl(activePeer.name, 32)}
            roundedCircle
            style={{ width: '32px', height: '32px', objectFit: 'cover', flexShrink: 0, border: '1px solid rgba(255,255,255,0.2)' }}
            onError={(e) => { e.target.onerror = null; e.target.src = placeholderAvatarUrl(activePeer.name, 32); }}
          />
          <div className="d-flex align-items-center gap-2 min-w-0">
            <Link
              to={`/profile/${activePeer.uid}`}
              className="fw-bold text-decoration-none text-truncate"
              style={{ color: '#ffffff', fontSize: '0.95rem' }}
            >
              {activePeer.name}
            </Link>
            <span
              className="d-inline-flex align-items-center gap-1 text-nowrap"
              style={{ fontSize: '0.75rem', opacity: 0.75, color: '#ffffff' }}
            >
              <Lock size={11} color="#ffffff" />
              <span>{t('dm.encryption_badge')}</span>
            </span>
          </div>
          <Button
            variant="link"
            size="sm"
            className="ms-auto text-decoration-none p-1 d-flex align-items-center"
            style={{ color: '#ffffff', opacity: 0.75 }}
            onClick={(e) => promptDeleteConversation(activeChatId, e)}
            title={lang === 'ru' ? 'Удалить переписку' : 'Delete conversation'}
          >
            <Trash2 size={17} />
          </Button>
        </Card.Header>

        {/* Two-column body: messages left, editor right — stacks vertically on mobile (see index.css) */}
        <div className="dm-chat-body">

          {/* Left: scrollable message feed with floating scroll-to-bottom button */}
          <div className="dm-messages-wrapper">
            <div className="dm-messages-col" ref={scrollContainerRef} onScroll={handleScroll}>
            <PrivacyNotice />
            {chatError ? (
              <ErrorCard
                title={lang === 'ru' ? 'Не удалось загрузить сообщения' : 'Failed to load messages'}
                error={chatError}
                onRetry={() => {
                  setChatError(null);
                  setLoadingChat(true);
                }}
              />
            ) : loadingChat ? (
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
                {hasMoreOlder && visibleMessages.length > 0 && (
                  <div className="text-center mb-3">
                    <Button 
                      variant="link" 
                      size="sm" 
                      disabled={loadingOlder}
                      className="text-muted text-decoration-none d-inline-flex align-items-center gap-2" 
                      onClick={handleLoadOlder}
                    >
                      {loadingOlder ? (
                        <>
                          <Spinner animation="border" size="sm" />
                          <span>{lang === 'ru' ? 'Загрузка...' : 'Loading...'}</span>
                        </>
                      ) : (
                        <span>{lang === 'ru' ? 'Загрузить более старые сообщения' : 'Load older messages'}</span>
                      )}
                    </Button>
                  </div>
                )}
                {visibleMessages.map((msg, index) => {
                  const isMe = msg.sender_uid === myUid;
                  const allConversationRolls = visibleMessages.reduce((acc, m) => ({ ...acc, ...(m.rolls || {}) }), {});

                  return (
                    <div
                      key={msg.id || index}
                      id={msg.id ? `dm-msg-${msg.id}` : undefined}
                      className={`d-flex mb-2 ${isMe ? 'justify-content-end' : 'justify-content-start'}`}
                    >
                      {!isMe && (
                        <Image
                          src={resolveAvatarUrl(activePeer?.avatar) || placeholderAvatarUrl(activePeer?.name, 32)}
                          roundedCircle
                          className="me-2"
                          style={{ width: '32px', height: '32px', minWidth: '32px', minHeight: '32px', flexShrink: 0, objectFit: 'cover' }}
                        />
                      )}
                      <div
                        className={`px-3 py-2 rounded-3 dm-chat-bubble ${isMe ? 'dm-bubble-me' : 'dm-bubble-peer'}`}
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
                        {/* Editing replaces the bubble in place, so the surrounding thread does not
                            jump while somebody fixes a typo. */}
                        {editingMsgId === msg.id ? (
                          <div className="w-100">
                            <Form.Control
                              as="textarea"
                              rows={3}
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              autoFocus
                            />
                            <div className="d-flex gap-2 justify-content-end mt-2">
                              <Button size="sm" variant="outline-secondary" onClick={handleCancelDmEdit}>
                                {lang === 'ru' ? 'Отмена' : 'Cancel'}
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={!editingText.trim()}
                                onClick={() => handleSaveDmEdit(msg)}
                              >
                                {lang === 'ru' ? 'Сохранить' : 'Save'}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {msg.deleted ? (
                              <div className="w-100 fst-italic opacity-75">
                                {lang === 'ru' ? 'Сообщение удалено' : 'Message deleted'}
                              </div>
                            ) : (
                              <div className="w-100">
                                <BBCode rolls={allConversationRolls} isDM={true}>{msg.text}</BBCode>
                              </div>
                            )}
                            <div
                              className="text-end mt-1"
                              style={{ fontSize: '0.875rem', opacity: 0.6 }}
                            >
                              {formatTs(msg.timestamp)}
                              {/* An edited message says so. A client that cannot
                                  show this should omit the marker rather than print
                                  a raw timestamp. */}
                              {msg.edited && !msg.deleted && (
                                <span className="ms-2">· {lang === 'ru' ? 'изменено' : 'edited'}</span>
                              )}
                            </div>
                            {/* Actions on YOUR OWN messages only. There is no
                                permission key here and there must not be: the server
                                decides by authorship, and a staff account gets no
                                extra power inside somebody else's conversation.
                                A tombstone offers neither action — there is no text
                                left to correct. */}
                            {isMe && !msg.deleted && editingMsgId !== msg.id && (
                              <div
                                className="d-flex gap-2 justify-content-end mt-1"
                                style={{ fontSize: '0.8rem' }}
                              >
                                <button
                                  type="button"
                                  className="dm-bubble-action"
                                  onClick={() => handleStartDmEdit(msg)}
                                >
                                  {lang === 'ru' ? 'Изменить' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  className="dm-bubble-action"
                                  onClick={() => handleDeleteDm(msg)}
                                >
                                  {lang === 'ru' ? 'Удалить' : 'Delete'}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
            </div>

            {/* Floating scroll-to-bottom / unread button */}
            {showScrollBottom && (
              <button
                type="button"
                onClick={scrollToUnreadOrBottom}
                className="dm-scroll-bottom-btn"
                style={{
                  position: 'absolute',
                  bottom: '18px',
                  right: '24px',
                  width: '42px',
                  height: '42px',
                  borderRadius: '50%',
                  background: 'var(--primary-color)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.25)',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 30,
                  cursor: 'pointer',
                }}
                title={unreadBelowCount > 0
                  ? (lang === 'ru' ? `Непрочитанных сообщений: ${unreadBelowCount}` : `${unreadBelowCount} unread messages`)
                  : (lang === 'ru' ? 'Вниз' : 'Scroll to bottom')}
              >
                <ChevronDown size={22} />
                {unreadBelowCount > 0 && (
                  <span
                    className="badge bg-danger rounded-pill position-absolute"
                    style={{
                      top: '-6px',
                      right: '-6px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      padding: '0.3em 0.55em',
                      border: '2px solid var(--card-bg)',
                      boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
                    }}
                  >
                    {unreadBelowCount > 99 ? '99+' : unreadBelowCount}
                  </span>
                )}
              </button>
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
                  ref={editorRef}
                  id="dm-reply-editor"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder={t('dm.placeholder')}
                  minHeight="38px"
                  rows={1}
                  autoResize={true}
                  hideFooter={true}
                  maxLength={computedMaxChars}
                  showDice={hasPermission && hasPermission(PERMISSIONS.USE_DICE)}
                  hideDiceType={true}
                  isEdit={false}
                  showHide={false}
                  smilesDropDirection="start"
                  smilesFullWidth={false}
                  onSubmit={handleSend}
                />
              </div>
              <div className="d-flex align-items-center justify-content-between mt-1 px-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSend}
                  disabled={sending || !messageText.trim()}
                  className="d-flex align-items-center gap-2 px-3 py-1"
                >
                  {sending ? <Spinner size="sm" animation="border" /> : <Send size={14} />}
                  <span>{t('dm.send_button')}</span>
                </Button>
                <div className={`${computedMaxChars && messageText.length >= computedMaxChars ? 'text-danger' : 'text-muted'} fw-semibold small`}>
                  {computedMaxChars > 0
                    ? `${messageText.length} / ${computedMaxChars}`
                    : `${lang === 'ru' ? 'Символов: ' : 'Chars: '}${messageText.length}`
                  }
                </div>
              </div>
            </div>
          )}

        </div>
      </Card>

      <ConfirmModal
        show={!!deleteConfirmConvId}
        onHide={() => setDeleteConfirmConvId(null)}
        onConfirm={handleConfirmDelete}
        title={lang === 'ru' ? 'Удалить переписку?' : 'Delete conversation?'}
        message={lang === 'ru'
          ? 'Вы уверены, что хотите безвозвратно удалить этот диалог у себя?'
          : 'Are you sure you want to permanently delete this conversation for yourself?'}
        confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
        cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
        variant="danger"
      />
    </>
  );
}

  // ── Inbox View ────────────────────────────────────────────────────────────
  return (
    <>
      <Card className="shadow-sm border-0 bg-card dm-fullscreen-card">
      <Card.Header className="py-2 px-3 d-flex align-items-center gap-2" style={{ flexShrink: 0, background: 'var(--nav-bg)', color: '#ffffff', minHeight: '44px' }}>
        <MessageCircle size={18} color="#ffffff" />
        <h5 className="mb-0 text-white" style={{ fontSize: '1rem' }}>{t('dm.inbox')}</h5>
      </Card.Header>
      <Card.Body className="p-3 d-flex flex-column" style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
        <PrivacyNotice />

        {inboxError ? (
          <ErrorCard
            title={lang === 'ru' ? 'Не удалось загрузить диалоги' : 'Failed to load conversations'}
            error={inboxError}
            onRetry={() => {
              setInboxError(null);
              setLoadingConvs(true);
            }}
          />
        ) : loadingConvs ? (
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
              // peerName is what the row PRINTS (localized "Deleted user" when the
              // peer is gone); peerRawName is the value the avatar is seeded from.
              // The two must differ: seeding the avatar with the localized label
              // would give a deleted account a language-dependent initial. The raw
              // entry is empty for a removed peer, so the shared helper draws the
              // one neutral "U" in every surface and language (plan D1).
              const peerRawName = conv.participantNames?.[peerUid] || '';
              const peerName = peerRawName || deletedDisplayName(lang);
              const peerAvatar = conv.participantAvatars?.[peerUid] || '';
              const unreadCount = conv.unread?.[myUid] || 0;
              return (
                <div
                  key={conv.id}
                  className="d-flex align-items-center gap-3 p-2 rounded cursor-pointer"
                  style={{ cursor: 'pointer', transition: 'background 0.15s' }}
                  onClick={() => { if (peerUid) openInboxConversation(conv); }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--block-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  role="button"
                >
                  <div className="position-relative">
                    <Image
                      src={resolveAvatarUrl(peerAvatar) || placeholderAvatarUrl(peerRawName, 44)}
                      roundedCircle
                      style={{ width: '44px', height: '44px', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { e.target.onerror = null; e.target.src = placeholderAvatarUrl(peerRawName, 44); }}
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
                  <div className="flex-grow-1 min-w-0 dm-conversation-info" style={{ minWidth: 0 }}>
                    <div className="d-flex justify-content-between align-items-baseline gap-2" style={{ minWidth: 0 }}>
                      <span
                        className={`fw-${unreadCount > 0 ? 'bold' : 'semibold'} text-truncate dm-conversation-name`}
                        style={{ flex: '1 1 auto', minWidth: 0, fontSize: '1rem' }}
                      >
                        {peerName}
                      </span>
                      {/* The date shares the FIRST line with the name and never
                          overlaps it: the name shrinks (truncate) while the
                          date keeps its width (flex-shrink 0, nowrap). Below
                          568px this span is hidden and the date moves to its
                          own second line (.dm-conversation-date-mobile), so
                          the timestamp is never printed twice. */}
                      <span
                        className="text-muted dm-conversation-date flex-shrink-0"
                        style={{ fontSize: '0.875rem', whiteSpace: 'nowrap' }}
                      >
                        {formatDate(conv.lastTimestamp)}
                      </span>
                    </div>
                    {/* Second line on wider screens: the words of the last
                        message, not a repeat of the date. Phones hide it —
                        there the second line carries the timestamp instead. */}
                    {conv.lastMessage && (
                      <p
                        className={`mb-0 text-truncate small dm-conversation-sub dm-conversation-preview ${unreadCount > 0 ? '' : 'text-muted'}`}
                        style={{ fontSize: '0.875rem' }}
                      >
                        {conv.lastMessage}
                      </p>
                    )}
                    {/* Second line on phones only: when the last message
                        arrived. Hidden above 568px, where the same date is
                        already on the first line. */}
                    <p
                      className="mb-0 text-truncate small dm-conversation-sub text-muted dm-conversation-date-mobile"
                      style={{ fontSize: '0.875rem' }}
                    >
                      {formatDate(conv.lastTimestamp)}
                    </p>
                  </div>
                  <Button
                    variant="link"
                    className="text-muted p-2 mx-1 shadow-none dm-trash-btn"
                    style={{ opacity: 0.6 }}
                    onClick={(e) => promptDeleteConversation(conv.id, e)}
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

    <ConfirmModal
      show={!!deleteConfirmConvId}
      onHide={() => setDeleteConfirmConvId(null)}
      onConfirm={handleConfirmDelete}
      title={lang === 'ru' ? 'Удалить переписку?' : 'Delete conversation?'}
      message={lang === 'ru'
        ? 'Вы уверены, что хотите безвозвратно удалить этот диалог у себя?'
        : 'Are you sure you want to permanently delete this conversation for yourself?'}
      confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
      cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
      variant="danger"
    />
  </>
);
};

export default DirectMessages;
