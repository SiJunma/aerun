import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthProvider';
import { makeStorageKey } from '../../utils/storageScope';
import MaintenanceLogoutModal from '../modals/MaintenanceLogoutModal';
import BannedLogoutModal from '../modals/BannedLogoutModal';
import DeletedLogoutModal from '../modals/DeletedLogoutModal';

const GlobalModals = () => {
  const { hasPermission, PERMISSIONS } = useAuth();
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false);
  const [showBannedModal, setShowBannedModal] = useState(false);
  const [showDeletedModal, setShowDeletedModal] = useState(false);

  useEffect(() => {
    // Check flags whenever the component mounts or permissions load
    const isMaintenanceRedirect = sessionStorage.getItem(makeStorageKey('maintenance_logout', 'guest')) === 'true';
    const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);

    if (isMaintenanceRedirect) {
      if (!isAdmin) {
        setTimeout(() => setShowMaintenanceModal(true), 0);
      }
      // Always remove the flag once it's been checked for maintenance
      sessionStorage.removeItem(makeStorageKey('maintenance_logout', 'guest'));
    }

    const isBannedRedirect = sessionStorage.getItem(makeStorageKey('banned_logout', 'guest')) === 'true';
    if (isBannedRedirect) {
      setTimeout(() => setShowBannedModal(true), 0);
      // We don't remove the banned flag here; it's cleared on onHide,
      // so the modal survives page transitions until manually acknowledged.
    }

    // Same shape as the ban: the flag survives until the member acknowledges
    // the modal, so the explanation is not lost to a redirect.
    const isDeletedRedirect = sessionStorage.getItem(makeStorageKey('deleted_logout', 'guest')) === 'true';
    if (isDeletedRedirect) {
      setTimeout(() => setShowDeletedModal(true), 0);
    }
  }, [hasPermission, PERMISSIONS.ADMIN_ACCESS]);

  return (
    <>
      <MaintenanceLogoutModal 
        show={showMaintenanceModal} 
        onHide={() => setShowMaintenanceModal(false)} 
      />

      <BannedLogoutModal
        show={showBannedModal}
        onHide={() => {
          setShowBannedModal(false);
          sessionStorage.removeItem(makeStorageKey('banned_logout', 'guest'));
        }}
      />

      <DeletedLogoutModal
        show={showDeletedModal}
        onHide={() => {
          setShowDeletedModal(false);
          sessionStorage.removeItem(makeStorageKey('deleted_logout', 'guest'));
        }}
      />
    </>
  );
};

export default GlobalModals;
