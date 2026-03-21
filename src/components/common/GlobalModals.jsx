import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthProvider';
import MaintenanceLogoutModal from '../modals/MaintenanceLogoutModal';
import BannedLogoutModal from '../modals/BannedLogoutModal';

const GlobalModals = () => {
  const { hasPermission, PERMISSIONS } = useAuth();
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false);
  const [showBannedModal, setShowBannedModal] = useState(false);

  useEffect(() => {
    // Check flags whenever the component mounts or permissions load
    const isMaintenanceRedirect = sessionStorage.getItem('maintenance_logout') === 'true';
    const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);

    if (isMaintenanceRedirect) {
      if (!isAdmin) {
        setTimeout(() => setShowMaintenanceModal(true), 0);
      }
      // Always remove the flag once it's been checked for maintenance
      sessionStorage.removeItem('maintenance_logout');
    }

    const isBannedRedirect = sessionStorage.getItem('banned_logout') === 'true';
    if (isBannedRedirect) {
      setTimeout(() => setShowBannedModal(true), 0);
      // We don't remove the banned flag here; it's cleared on onHide,
      // so the modal survives page transitions until manually acknowledged.
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
          sessionStorage.removeItem('banned_logout');
        }}
      />
    </>
  );
};

export default GlobalModals;
