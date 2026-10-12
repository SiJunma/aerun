import React, { useState } from 'react';
import { Button } from 'react-bootstrap';
import { Copy, Trash2, FileText, AlertTriangle, Lock } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import ForumModal from '../common/ForumModal';
import { REASON_TOPIC_UNAVAILABLE } from '../../api/unsent-replies';

/**
 * Shows a reply the member wrote that the forum never sent.
 *
 * THE ONE JOB. The text is READABLE and COPYABLE, and it cannot be lost from
 * here by accident: deleting it takes a deliberate second click. Everything
 * else about this modal follows from that.
 *
 * WHY THE TEXT IS A <pre> AND NOT THE EDITOR. It is a copy of something, not a
 * form. Rendering it in the composer would imply it can be submitted again —
 * and the topic it was written for is closed or gone, so it cannot. BBCode is
 * deliberately not applied either: what has to survive onto the clipboard is
 * the SOURCE, because that is what the composer reads, exactly as DraftsPage's
 * handleCopyText reasons.
 *
 * WHY ForumModal. Every modal in this project goes through it; a raw
 * react-bootstrap Modal can get stuck in EXITING and swallow every click over
 * the forum (ForumModal.jsx's header comment, and scripts/check-no-raw-modal.mjs
 * which fails the build on a raw one — including on the phrase itself written in
 * a comment, which is why it is spelled without angle brackets here).
 */
const UnsentReplyModal = ({ show, rescue, onHide, onDelete }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);

  if (!rescue) return null;

  const unavailable = rescue.reason === REASON_TOPIC_UNAVAILABLE;

  const handleCopy = async () => {
    const text = rescue.content || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('unsent_reply.copied', 'Текст скопирован'), 'success');
    } catch (err) {
      console.error('[UnsentReplyModal] copy error:', err);
      // clipboard.writeText needs a secure context and can be refused outright,
      // so the fallback is the member selecting it by hand — which the <pre>
      // below is selectable for.
      showToast(t('unsent_reply.copy_failed', 'Не удалось скопировать. Выделите текст вручную.'), 'danger');
    }
  };

  const handleDelete = () => {
    // Two clicks, because this is the only action in the modal that destroys
    // the text — and the member reached it precisely because they lost text
    // once already.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onDelete(rescue.topicId);
    setConfirming(false);
  };

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={t('unsent_reply.title', 'Неотправленный ответ')}
      size="lg"
    >
      <div className="py-2">
        <div className="d-flex align-items-start gap-3 mb-3">
          <div
            className="d-inline-flex p-3 rounded-circle flex-shrink-0"
            style={{ background: 'rgba(245, 158, 11, 0.12)', border: '2px solid rgba(245, 158, 11, 0.2)' }}
          >
            {unavailable
              ? <AlertTriangle size={28} style={{ color: '#f59e0b' }} />
              : <Lock size={28} style={{ color: '#f59e0b' }} />}
          </div>
          <div>
            <p className="mb-2">
              {unavailable
                ? t('unsent_reply.reason_unavailable', 'Тема была удалена или скрыта, поэтому отправить ответ в неё уже нельзя. Текст сохранён — скопируйте его, чтобы не потерять.')
                : t('unsent_reply.reason_closed', 'Тема закрыта для новых ответов, поэтому отправить его не получилось. Текст сохранён — скопируйте его, чтобы не потерять.')}
            </p>
            {rescue.saved_at && (
              <p className="text-muted small mb-0">
                {t('unsent_reply.saved_at', 'Сохранено:')} {new Date(rescue.saved_at).toLocaleString()}
              </p>
            )}
          </div>
        </div>

        {/* user-select is explicit: the whole point of this block is that the
            member can select it by hand when the clipboard is refused. */}
        <pre
          className="p-3 rounded mb-3"
          style={{
            maxHeight: '45vh',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(0, 0, 0, 0.04)',
            userSelect: 'text',
            fontSize: '0.95rem',
            marginBottom: 0
          }}
        >
          {rescue.content}
        </pre>

        <div className="d-flex flex-wrap gap-2 justify-content-end mt-3">
          <Button variant="outline-secondary" onClick={onHide} className="rounded-pill px-3">
            {t('common.close', 'Закрыть')}
          </Button>
          <Button
            variant={confirming ? 'danger' : 'link'}
            className={confirming ? 'rounded-pill px-3' : 'footer-link'}
            onClick={handleDelete}
          >
            <Trash2 size={14} className="me-1" />
            {confirming
              ? t('unsent_reply.delete_confirm', 'Точно удалить?')
              : t('unsent_reply.delete', 'Удалить этот текст')}
          </Button>
          <Button variant="primary" onClick={handleCopy} className="rounded-pill px-4">
            <Copy size={16} className="me-1" />
            {t('unsent_reply.copy', 'Копировать')}
          </Button>
        </div>

        {confirming && (
          <p className="text-danger small text-end mt-2 mb-0">
            <FileText size={12} className="me-1" />
            {t('unsent_reply.delete_warning', 'После удаления восстановить текст будет нельзя.')}
          </p>
        )}
      </div>
    </ForumModal>
  );
};

export default UnsentReplyModal;
