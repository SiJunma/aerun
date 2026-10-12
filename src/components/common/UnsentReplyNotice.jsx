import React, { useState, useEffect } from 'react';
import { Button } from 'react-bootstrap';
import { FileText } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import UnsentReplyModal from '../modals/UnsentReplyModal';
import {
  listUnsentReplies,
  clearUnsentReply,
  subscribeToUnsentReplies,
  UNSENT_REPLY_PREFIX
} from '../../api/unsent-replies';

/**
 * The global surface for a reply the forum never sent.
 *
 * WHY IT IS GLOBAL. The rescue is only reachable from here. When the reason is
 * `topic_unavailable` the topic page is GONE — it renders the not-found card and
 * the composer that held the text no longer exists — so a button on TopicPage
 * would be a button on a page nobody can reach. Mounting next to GlobalModals
 * (App.jsx) is the established place for exactly this shape of cross-page notice
 * driven by a storage flag.
 *
 * WHAT IT DOES. Auto-opens the modal when a rescue is written, and otherwise
 * offers a small button that reopens it. Dismissing either deletes nothing —
 * only a successful submit or the modal's delete button clear the key.
 *
 * WHY IT DOES NOT HIDE ON THE TOPIC'S OWN PAGE. It could, and the temptation is
 * that the topic page already has the text in its form. But the reason the key
 * was written is that the form is no longer usable there — a locked topic hides
 * the composer — so hiding the button would hide the only remaining way to read
 * what was written. The modal is a copy, not the form; both can be open.
 */
const UnsentReplyNotice = () => {
  const { t } = useI18n();
  const { user } = useAuth();

  // The rescue is per-account. Reading the list into state and comparing the
  // account it belongs to on the way out is React's documented "adjust state
  // when a prop changes" pattern, and it does the two jobs that would otherwise
  // need a mount effect: it seeds the list on the first render, and it re-reads
  // when the signed-in member changes — without which switching accounts on a
  // shared browser would show the previous member's text.
  //
  // `listUnsentReplies` is a localStorage read, so this is synchronous and safe
  // to call during render, and it is the same function the bus below calls.
  const uid = user?.uid;
  const [read, setRead] = useState(() => ({ uid, items: uid ? listUnsentReplies(uid) : [] }));
  if (read.uid !== uid) {
    setRead({ uid, items: uid ? listUnsentReplies(uid) : [] });
  }
  const rescues = read.items;

  // Which rescue the modal is showing, plus a nonce that makes EVERY open a new
  // open. The nonce is what removes the need for a "close the stale one" effect:
  // the same topic rescued twice in a row yields a new nonce, so the modal
  // re-opens instead of silently updating a hidden one. A rescue that was
  // deleted simply stops being found below, and the modal renders nothing.
  const [open, setOpen] = useState({ topicId: null, nonce: 0 });

  useEffect(() => {
    // The same-tab bus. A write in this tab (TopicPage's catch, or the modal's
    // delete) calls `announce`, so the notice updates without waiting for a
    // navigation or a reload. A write in ANOTHER tab arrives as a `storage`
    // event, which localStorage does emit — the in-tab bus is what does not
    // cross tabs.
    const onBus = (detail) => {
      // Only this member's writes matter; the bus is process-wide.
      if (detail?.uid && detail.uid !== uid) return;
      setRead({ uid, items: uid ? listUnsentReplies(uid) : [] });
      // A rescue written RIGHT NOW is what the member should be looking at, so
      // it opens by itself. They still have to act to get rid of it.
      if (detail?.action === 'saved' && detail.topicId) {
        setOpen((prev) => ({ topicId: detail.topicId, nonce: prev.nonce + 1 }));
      }
    };
    const onStorage = (event) => {
      if (event.key && !event.key.startsWith(UNSENT_REPLY_PREFIX)) return;
      setRead({ uid, items: uid ? listUnsentReplies(uid) : [] });
    };

    const unsub = subscribeToUnsentReplies(onBus);
    window.addEventListener('storage', onStorage);
    return () => {
      unsub();
      window.removeEventListener('storage', onStorage);
    };
  }, [uid]);

  const openRescue = rescues.find((r) => r.topicId === open.topicId) || null;

  if (!uid || rescues.length === 0) return null;

  return (
    <>
      {openRescue && (
        <UnsentReplyModal
          show
          rescue={openRescue}
          onHide={() => setOpen((prev) => ({ ...prev, topicId: null }))}
          onDelete={(topicId) => {
            clearUnsentReply(topicId, uid);
            setOpen((prev) => ({ ...prev, topicId: null }));
          }}
        />
      )}

      {/* Hidden while that rescue's own modal is open, so the member is not
          offered a button to open what is already in front of them. With more
          than one rescue the button still opens the newest; the modal's close
          brings the rest back into reach one at a time. */}
      {!openRescue && (
        <div
          className="position-fixed"
          style={{ right: '1.25rem', bottom: '1.25rem', zIndex: 1040 }}
        >
          <Button
            variant="warning"
            className="rounded-pill shadow-sm d-flex align-items-center gap-2 px-3 py-2"
            onClick={() => setOpen((prev) => ({ topicId: rescues[0].topicId, nonce: prev.nonce + 1 }))}
          >
            <FileText size={16} />
            {rescues.length === 1
              ? t('unsent_reply.notice_one', 'У вас есть неотправленный ответ')
              : t('unsent_reply.notice_many', 'У вас есть неотправленные ответы ({n})', { n: rescues.length })}
          </Button>
        </div>
      )}
    </>
  );
};

export default UnsentReplyNotice;
