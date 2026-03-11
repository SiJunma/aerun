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
 */
const ProtectedRoute = ({ children, requireActive = true, requireAdmin = false, requirePosting = false }) => {
  const { user, profile, settings, loading } = useAuth();
  const location = useLocation();

  if (loading || !settings) {
    return null; // AuthProvider handles the global preloader
  }

  // Not logged in at all → /login
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Maintenance mode check: redirect non-admins to /maintenance
  // We MUST wait for profile to exist if user is logged in, to avoid race conditions 
  // where profile is null for a split second and the system thinks it's a non-admin.
  if (settings.maintenanceMode && location.pathname !== '/maintenance') {
    if (!profile) {
      return (
        <div className="d-flex justify-content-center align-items-center vh-100">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading Profile...</span>
          </div>
        </div>
      );
    }

    if (profile.role_id !== 'admin') {
      return <Navigate to="/maintenance" replace />;
    }
  }

  // Banned → /banned (always checked first when logged in)
  if (profile?.status === 'banned') {
    return <Navigate to="/banned" replace />;
  }

  // Pending (not yet approved) → /pending
  if (requireActive && profile?.status === 'pending') {
    return <Navigate to="/pending" replace />;
  }

  // Admin-only route: kick non-admins back home
  if (requireAdmin && profile?.role_id !== 'admin') {
    return <Navigate to="/" replace />;
  }

  // Posting-required route: spectators cannot post, create topics, etc.
  if (requirePosting && profile?.role_id === 'spectator') {
    return <Navigate to="/" replace />;
  }

  return children;
};

export default ProtectedRoute;
