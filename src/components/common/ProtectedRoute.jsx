import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';

/**
 * ProtectedRoute — Role-Based Access Control wrapper.
 *
 * Props:
 *  requireActive  {boolean} – if true, pending/banned users are bounced (default: true)
 *  requireAdmin   {boolean} – if true, only role_id='admin' may enter (default: false)
 *  requirePosting {boolean} – if true, spectators are bounced (cannot post/create, default: false)
 *  requireDm      {boolean} – if true, requires USE_DIRECT_MESSAGES permission (default: false)
 */
const ProtectedRoute = ({ children, requireActive = true, requireAdmin = false, requirePosting = false, requireDm = false, allowGuest = false }) => {
  const { user: firebaseUser, profile, settings, loading, hasPermission, PERMISSIONS } = useAuth();
  const location = useLocation();

  if (loading || !settings) {
    return null; // AuthProvider handles the global preloader
  }

  // Shadow logout for banned users: treat them as guests immediately in terms of routing.
  // This avoids the jump to /banned before AuthProvider triggers the real logout().
  //
  // Read from `status`, not from role_id. The account state was split out of the
  // role (internal/auth/status.go), and the legacy app encoded a ban as
  // role_id "banned" — so keying this off the role meant a banned account was
  // still routed as a full member on the client even though the server had
  // already stripped every permission from it.
  const isBanned = profile?.status === 'banned';
  const user = isBanned ? null : firebaseUser;

  // Not logged in at all → /login (unless allowGuest is true and whitelistMode is OFF)
  if (!user) {
    // More permissive check: if whitelistMode is missing or explicitly false, allow guests
    const isWhitelistOff = !settings.whitelistMode;
    if (allowGuest && isWhitelistOff && !requireAdmin) {
      return children;
    }

    // If whitelist is OFF, we can send them to the home page directly instead of /login
    // This avoids a "LoginPage -> HomePage" double redirect flicker.
    if (isWhitelistOff) {
      return <Navigate to="/" replace />;
    }

    // Whitelist (White Wall for Guests) is ON → the login page is the wall.
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Banned status handling - only relevant if they are on /banned already or if they are "shadow logged out"
  if (isBanned) {
    // If whitelist is OFF, we always land them on the home page as a guest.
    // This satisfies the requirement to "keep them on the home page" during termination.
    if (settings.whitelistMode === false && location.pathname !== '/') {
      return <Navigate to="/" replace />;
    }
    // If whitelist is ON, we might still want to show them the /banned page if they navigate there
    if (settings.whitelistMode === true && location.pathname !== '/banned') {
       return <Navigate to="/banned" replace />;
    }
  }

  // Pending status handling
  // When whitelistMode is OFF, pending users browse like spectators (read-only).
  // They are only blocked from routes that require posting or admin access.
  if (profile?.status === 'pending') {
    const isWhitelistOff = !settings.whitelistMode;
    const treatedAsSpectator = isWhitelistOff && !requireAdmin && !requirePosting;
    // The DM area is the one exception to the white wall. A message addressed
    // to this member is not forum content — it is their own correspondence, and
    // the owner ruled that a pending member answers inside a dialogue somebody
    // opened with them. The DM route itself still checks the DM permission
    // below, and the server refuses a pending account that tries to OPEN one.
    const isDmRoute = requireDm;
    if (requireActive && !treatedAsSpectator && !isDmRoute && location.pathname !== '/pending') {
      return <Navigate to="/pending" replace />;
    }
  } else if (location.pathname === '/pending') {
    return <Navigate to="/" replace />;
  }

  // Admin-only route: kick non-admins back home
  if (requireAdmin && !hasPermission(PERMISSIONS.ADMIN_ACCESS)) {
    return <Navigate to="/" replace />;
  }

  // Posting-required route: spectators cannot post, create topics, etc.
  if (requirePosting && profile?.role_id === 'spectator') {
    return <Navigate to="/" replace />;
  }

  // DM-required route: requires USE_DIRECT_MESSAGES permission
  if (requireDm && !hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES)) {
    return <Navigate to="/" replace />;
  }

  return children;
};

export default ProtectedRoute;
