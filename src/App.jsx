import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import ProtectedRoute from './components/common/ProtectedRoute';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import PendingPage from './pages/PendingPage';
import BannedPage from './pages/BannedPage';
import MainPage from './pages/MainPage';
import CategoryPage from './pages/CategoryPage';
import TopicFormPage from './pages/TopicFormPage';
import TopicPage from './pages/TopicPage';
import ProfilePage from './pages/ProfilePage';
import MembersPage from './pages/MembersPage';
import AdminPage from './pages/AdminPage';
import MaintenancePage from './pages/MaintenancePage';
import { useAuth } from './contexts/AuthProvider';

/**
 * ActivityTracker — records every route change as user activity.
 * Mounted once inside the Router so it has access to useLocation.
 */
const ActivityTracker = () => {
  const location = useLocation();
  const { recordActivity } = useAuth();

  useEffect(() => {
    if (recordActivity) recordActivity();
  }, [location.pathname, recordActivity]);

  return null;
};

const App = () => {
  return (
    <>
      <ActivityTracker />
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/pending" element={<ProtectedRoute requireActive={false}><PendingPage /></ProtectedRoute>} />
        <Route path="/banned" element={<ProtectedRoute requireActive={false}><BannedPage /></ProtectedRoute>} />

        {/* Active-user Routes (players, spectators, mods, admins) */}
        <Route path="/" element={<ProtectedRoute><Layout><MainPage /></Layout></ProtectedRoute>} />
        <Route path="/category/:id" element={<ProtectedRoute><Layout><CategoryPage /></Layout></ProtectedRoute>} />
        <Route path="/topic/:id" element={<ProtectedRoute><Layout><TopicPage /></Layout></ProtectedRoute>} />
        <Route path="/members" element={<ProtectedRoute><Layout><MembersPage /></Layout></ProtectedRoute>} />
        <Route path="/profile/:uid" element={<ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>} />

        {/* Posting-required Routes (spectators blocked) */}
        <Route path="/category/:categoryId/new-topic" element={<ProtectedRoute requirePosting><Layout><TopicFormPage /></Layout></ProtectedRoute>} />

        {/* Admin-only Routes */}
        <Route path="/admin" element={<ProtectedRoute requireAdmin><Layout><AdminPage /></Layout></ProtectedRoute>} />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
};

export default App;
