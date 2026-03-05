import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/common/ProtectedRoute';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';
import PendingPage from './pages/PendingPage';
import BannedPage from './pages/BannedPage';
import MainPage from './pages/MainPage';
import CategoryPage from './pages/CategoryPage';
import TopicFormPage from './pages/TopicFormPage';
import TopicPage from './pages/TopicPage';
import ProfilePage from './pages/ProfilePage';
import MembersPage from './pages/MembersPage';
import AdminPage from './pages/AdminPage';

const App = () => {
  return (
    <Routes>
      {/* Public Routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/pending" element={<ProtectedRoute requireActive={false}><PendingPage /></ProtectedRoute>} />
      <Route path="/banned" element={<ProtectedRoute requireActive={false}><BannedPage /></ProtectedRoute>} />
      
      {/* Protected Routes */}
      <Route path="/" element={<ProtectedRoute><Layout><MainPage /></Layout></ProtectedRoute>} />
      <Route path="/category/:id" element={<ProtectedRoute><Layout><CategoryPage /></Layout></ProtectedRoute>} />
      <Route path="/category/:categoryId/new-topic" element={<ProtectedRoute><Layout><TopicFormPage /></Layout></ProtectedRoute>} />
      <Route path="/topic/:id" element={<ProtectedRoute><Layout><TopicPage /></Layout></ProtectedRoute>} />
      <Route path="/profile/:uid" element={<ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>} />
      <Route path="/members" element={<ProtectedRoute><Layout><MembersPage /></Layout></ProtectedRoute>} />
      <Route path="/members" element={<ProtectedRoute><Layout><MembersPage /></Layout></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute><Layout><AdminPage /></Layout></ProtectedRoute>} />

      {/* Catch all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App;
