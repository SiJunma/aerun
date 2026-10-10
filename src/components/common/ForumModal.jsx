import React from 'react';
import { Modal } from 'react-bootstrap';

/**
 * Unified Modal component for Aerun Forum — the ONLY sanctioned way to render
 * a modal in this project (scripts/check-no-raw-modal.mjs enforces it).
 *
 * WHY `if (!show) return null` INSTEAD OF `<Modal show={show}>`.
 * react-bootstrap closes a `<Modal show={show}>` through an exit transition,
 * and that transition is a single point of failure: DialogTransition passes
 * `timeout: null`, so the modal node is only unmounted — and body.modal-open
 * only released — when a CSS `transitionend` (plus dom-helpers' fallback
 * timer) delivers the completion signal. When that signal is lost — e.g. the
 * auth state storm after a sign-in re-renders the subtree mid-fade — the
 * dialog stays in EXITING forever: invisible (no `.show` → opacity 0) yet
 * still occupying the layout and swallowing every click over the forum, with
 * the body scroll lock still held. This exact bug shipped twice (after
 * registration, after email sign-in) and again via the profile reputation
 * modal, which was the last raw <Modal> holdout.
 *
 * Returning null when closed removes the whole Modal (portal children, focus
 * listeners and the ModalManager's body lock via its unmount cleanup)
 * SYNCHRONOUSLY: there is no exit transition left to interrupt, so this class
 * of bug cannot occur by construction. The cost is that modals close without
 * a fade-out — they never had one here anyway, since every ForumModal in the
 * project already behaved this way.
 *
 * The optional *ClassName props default to the historical markup, so callers
 * can migrate a raw <Modal> without any visual change.
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
  // Renders the header even without a title (close-button-only header), for
  // modals like AuthModal whose body carries its own heading.
  showHeader,
  headerClassName = "border-0",
  titleClassName = "fw-bold",
  bodyClassName = "p-4",
  footerClassName = "border-0",
  ...props
}) => {
  if (!show) return null;
  const withHeader = showHeader ?? title != null;

  return (
    <Modal
      show={true}
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
      {withHeader && (
        <Modal.Header closeButton={showCloseButton} className={headerClassName}>
          {title ? <Modal.Title className={titleClassName}>{title}</Modal.Title> : null}
        </Modal.Header>
      )}
      <Modal.Body className={bodyClassName}>
        {children}
      </Modal.Body>
      {footer && (
        <Modal.Footer className={footerClassName}>
          {footer}
        </Modal.Footer>
      )}
    </Modal>
  );
};

export default ForumModal;
