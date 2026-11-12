import React from 'react';
import { Badge } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { getRoleVisuals, resolveUserRole } from '../../constants/permissions';

/**
 * Shared component for rendering role and status badges (Banned, Deleted, Pending).
 * 
 * Props:
 *   roleId      {string}  — The UID of the role
 *   status      {string?} — Account STATUS (active | pending | banned). Separate
 *                           from the role since internal/auth split the two
 *   userEmail   {string?} — Used to resolve Chief Admin role
 *   isDeleted   {boolean} — Whether the user record is missing/deleted
 *   className   {string?} — Extra CSS classes
 */
const ForumRoleBadge = ({
  roleId,
  status,
  userEmail,
  isDeleted = false,
  className = ''
}) => {
  const { t } = useI18n();
  const { roles } = useAuth();

  if (isDeleted) {
    return (
      <Badge className={`role-badge badge-deleted ${className}`}>
        {t('role.deleted')}
      </Badge>
    );
  }

  // The status column decides this, NOT the role. `banned` and `pending` were
  // legacy pseudo-roles and are deliberately absent from the role vocabulary
  // (internal/auth), so an account carrying one has an ordinary role_id like
  // 'player' and the role-only comparison could never fire — a banned member
  // was badged with its role and read as a normal one. Both pages were already
  // passing `status` to a component that ignored it.
  const effectiveStatus = status || roleId;

  if (effectiveStatus === 'banned') {
    return (
      <Badge className={`role-badge badge-banned ${className}`}>
        {t('role.banned')}
      </Badge>
    );
  }

  if (effectiveStatus === 'pending') {
    return (
      <Badge className={`role-badge badge-pending ${className}`}>
        {t('role.pending')}
      </Badge>
    );
  }

  // Resolve standard role visuals
  const resolvedId = resolveUserRole(userEmail, roleId);
  const visuals = getRoleVisuals(resolvedId, roles);

  return (
    <Badge 
      bg={visuals.color} 
      className={`role-badge ${className} ${visuals.isLight ? 'text-dark' : 'text-white'}`}
    >
      {visuals.name}
    </Badge>
  );
};

export default ForumRoleBadge;
