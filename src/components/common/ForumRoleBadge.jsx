import React from 'react';
import { Badge } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { getRoleVisuals, resolveUserRoleId } from '../../constants/permissions';

/**
 * Shared component for rendering role and status badges (Banned, Deleted, Pending).
 * 
 * Props:
 *   roleId      {string}  — The UID of the role
 *   status      {string?} — User status (banned, pending)
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
  const { lang } = useI18n();
  const { roles } = useAuth();

  if (isDeleted) {
    return (
      <Badge className={`role-badge badge-deleted ${className}`}>
        {lang === 'ru' ? 'Удален' : 'Deleted'}
      </Badge>
    );
  }

  if (status === 'banned') {
    return (
      <Badge className={`role-badge badge-banned ${className}`}>
        {lang === 'ru' ? 'Забанен' : 'Banned'}
      </Badge>
    );
  }

  if (status === 'pending') {
    return (
      <Badge bg="info" className={`role-badge ${className} text-white`}>
        {lang === 'ru' ? 'Ожидает' : 'Pending'}
      </Badge>
    );
  }

  // Resolve standard role visuals
  const resolvedId = resolveUserRoleId(userEmail, roleId);
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
