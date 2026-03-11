import React from 'react';
import { Modal } from 'react-bootstrap';

/**
 * Unified Modal component for Aerun Forum.
 * Fixes "stuck in DOM" issues by using unmountOnExit={true}.
 * Applies consistent premium styling and standardizes modal structure.
 */
const ForumModal = ({
  show,
  onHide,
  title,
  children,
  footer,
  size,
  centered = true,
  animation = true,
  backdrop = true,
  className = "premium-modal",
  backdropClassName = "confirm-modal-backdrop",
  showCloseButton = true,
  ...props
}) => {
  return (
    <Modal
      show={show}
      onHide={onHide}
      centered={centered}
      animation={animation}
      backdrop={backdrop}
      size={size}
      className={className}
      backdropClassName={backdropClassName}
      enforceFocus={false}
      restoreFocus={false}
      {...props}
    >
      {title && (
        <Modal.Header closeButton={showCloseButton} className="border-0">
          <Modal.Title className="fw-bold">{title}</Modal.Title>
        </Modal.Header>
      )}
      <Modal.Body className="p-4">
        {children}
      </Modal.Body>
      {footer && (
        <Modal.Footer className="border-0">
          {footer}
        </Modal.Footer>
      )}
    </Modal>
  );
};

export default ForumModal;
