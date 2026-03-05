import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';

const ProtectedRoute = ({ children, requireActive = true }) => {
  const { user, profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center vh-100">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requireActive && profile?.status === 'pending') {
    return <Navigate to="/pending" replace />;
  }

  if (profile?.status === 'banned') {
    return <Navigate to="/banned" replace />;
  }

  return children;
};

export default ProtectedRoute;
