import React from 'react';
import { Button } from 'react-bootstrap';
import { UserX } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import ForumModal from '../common/ForumModal';

// The counterpart of BannedLogoutModal for a SOFT-DELETED account.
//
// The two states are told apart in the copy, because they are told apart in
// the product: a ban is a temporary staff decision that can be lifted, while
// a soft delete retires the account — the session is dead, the profile keeps
// rendering for everybody else, and nothing here can be undone from the
// browser.
const DeletedLogoutModal = ({ show, onHide }) => {
  const { t } = useI18n();

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={t('auth.deleted_logout_title')}
      size="md"
    >
      <div className="text-center py-3">
        <div
          className="d-inline-flex p-4 rounded-circle mb-4"
          style={{ background: 'rgba(108, 117, 125, 0.1)', border: '2px solid rgba(108, 117, 125, 0.2)' }}
        >
          <UserX size={48} className="text-secondary" />
        </div>
        <p className="fs-5 mb-4 px-2">
          {t('auth.deleted_logout_message')}
        </p>
        <div className="d-grid gap-2 col-md-8 mx-auto">
          <Button
            variant="primary"
            onClick={onHide}
            className="fw-bold py-2 shadow-sm rounded-pill"
          >
            {t('common.close') || 'Close'}
          </Button>
        </div>
      </div>
    </ForumModal>
  );
};

export default DeletedLogoutModal;
