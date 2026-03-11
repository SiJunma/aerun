import React from 'react';
import { Button } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import ForumModal from './ForumModal';

const ConfirmModal = ({
  show,
  onHide,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  variant = 'danger'
}) => {
  const { t } = useI18n();

  const footer = (
    <>
      <Button
        variant="link"
        className="text-decoration-none text-muted fw-bold me-2"
        onClick={onHide}
      >
        {cancelText || t('common.cancel') || 'Cancel'}
      </Button>
      <Button
        variant={variant}
        className="px-4 fw-bold shadow-sm"
        onClick={() => {
          onConfirm();
          onHide();
        }}
      >
        {confirmText || t('common.confirm') || 'Confirm'}
      </Button>
    </>
  );

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={title || t('common.confirm_title') || 'Confirm Action'}
      footer={footer}
      className="confirm-modal"
    >
      <p className="mb-0 text-muted">
        {message || t('common.confirm_message') || 'Are you sure you want to proceed?'}
      </p>
    </ForumModal>
  );
};

export default ConfirmModal;
