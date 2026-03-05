import React from 'react';
import { Modal, Button } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';

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

  return (
    <Modal 
      show={show} 
      onHide={onHide} 
      centered 
      className="confirm-modal"
      backdropClassName="confirm-modal-backdrop"
    >
      <Modal.Header closeButton className="border-0 pb-0">
        <Modal.Title className="h5 fw-bold">
          {title || t('common.confirm_title') || 'Confirm Action'}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="py-4">
        <p className="mb-0 text-muted">
          {message || t('common.confirm_message') || 'Are you sure you want to proceed?'}
        </p>
      </Modal.Body>
      <Modal.Footer className="border-0 pt-0">
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
      </Modal.Footer>
    </Modal>
  );
};

export default ConfirmModal;
