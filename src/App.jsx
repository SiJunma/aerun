import React, { useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
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
import NotificationsPage from './pages/NotificationsPage';
import ActiveTopicsPage from './pages/ActiveTopicsPage';
import NewRepliesPage from './pages/NewRepliesPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import DraftsPage from './pages/DraftsPage';
import MessagesPage from './pages/MessagesPage';
import { useAuth } from './contexts/AuthProvider';
import GlobalModals from './components/common/GlobalModals';
import UnsentReplyNotice from './components/common/UnsentReplyNotice';
import RealtimeStatusBanner from './components/common/RealtimeStatusBanner';

/**
 * ActivityTracker — records every route change as user activity.
 * Mounted once inside the Router so it has access to useLocation.
 * Skips the mount render: the presence loop already beats on cold start, so a
 * mount-beat here is a guaranteed duplicate.
 */
const ActivityTracker = () => {
  const location = useLocation();
  const { recordActivity } = useAuth();
  const mountedRef = React.useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (recordActivity) recordActivity();
  }, [location.pathname, recordActivity]);

  return null;
};

/**
 * IdentityRedirect — sends the visitor home when WHO they are changes.
 *
 * ProtectedRoute already bounces people off routes they may not enter, but it
 * answers only the routes it wraps. A topic page renders as a guest when the
 * session ends underneath it: the post list request is then refused by the
 * server (canViewTopic), and the member is left staring at whatever the page
 * managed to render before the refusal — an empty shell that looks like a
 * broken topic rather than a finished session.
 *
 * The rule is deliberately blunt — ANY change of identity lands on "/":
 *
 *   - signing out, anywhere, including from inside a topic that is now closed;
 *   - a role or status change applied by a moderator while the tab is open,
 *     which can revoke access to the very page being read;
 *   - signing in, so a guest deep in a thread lands on the index rather than
 *     staying on a URL whose content is about to change shape.
 *
 * It runs on identity, not on pathname, so it never fights the router: the
 * first render of a fresh page load has no previous identity to compare
 * against and is left alone, which is what keeps a direct link to a topic
 * working normally.
 */
const IdentityRedirect = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const identity = `${user?.uid || ''}|${profile?.role || ''}|${profile?.status || ''}`;
  const previousIdentityRef = useRef(identity);

  useEffect(() => {
    const previous = previousIdentityRef.current;
    previousIdentityRef.current = identity;

    // No change, or the very first run: not a transition.
    if (previous === identity) return;
    // Only redirect away from somewhere; "/" is where they belong now.
    if (window.location.pathname === '/') return;

    navigate('/', { replace: true });
  }, [identity, navigate]);

  return null;
};

/**
 * ScrollToTop — resets scroll to top on every route change (simulating page
 * navigation).
 * Does not trigger on search param changes (like pagination).
 */
const ScrollToTop = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);
  return null;
};

const App = () => {
  // Only the id, and only for the banner: the resource it watches is keyed by
  // account, and a null uid is the honest "signed out" answer the banner already
  // handles by rendering nothing.
  const { user } = useAuth();

  return (
    <>
      <ActivityTracker />
      <ScrollToTop />
      <IdentityRedirect />
      <GlobalModals />
      {/* The rescue for a reply the forum never sent. Mounted HERE, outside the
          router, because the case that needs it most is the one where the topic
          page no longer exists to show it on. */}
      <UnsentReplyNotice />
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/pending" element={<ProtectedRoute requireActive={false}><Layout><PendingPage /></Layout></ProtectedRoute>} />
        <Route path="/banned" element={<ProtectedRoute requireActive={false}><Layout><BannedPage /></Layout></ProtectedRoute>} />

        {/* Active-user Routes (players, spectators, mods, admins) */}
        <Route path="/" element={<ProtectedRoute allowGuest><Layout><MainPage /></Layout></ProtectedRoute>} />
        <Route path="/category/:id" element={<ProtectedRoute allowGuest><Layout><CategoryPage /></Layout></ProtectedRoute>} />
        <Route path="/topic/:id" element={<ProtectedRoute allowGuest><Layout><TopicPage /></Layout></ProtectedRoute>} />
        <Route path="/members" element={<ProtectedRoute allowGuest><Layout><MembersPage /></Layout></ProtectedRoute>} />
        <Route path="/profile/:uid" element={<ProtectedRoute allowGuest><Layout><ProfilePage /></Layout></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Layout><NotificationsPage /></Layout></ProtectedRoute>} />
        <Route path="/messages" element={<ProtectedRoute requireDm><Layout><MessagesPage /></Layout></ProtectedRoute>} />
        <Route path="/messages/:uid" element={<ProtectedRoute requireDm><Layout><MessagesPage /></Layout></ProtectedRoute>} />
        <Route path="/active-topics" element={<ProtectedRoute allowGuest><Layout><ActiveTopicsPage /></Layout></ProtectedRoute>} />
        <Route path="/new-replies" element={<ProtectedRoute allowGuest><Layout><NewRepliesPage /></Layout></ProtectedRoute>} />
        <Route path="/subscriptions" element={<ProtectedRoute><Layout><SubscriptionsPage /></Layout></ProtectedRoute>} />
        <Route path="/drafts" element={<ProtectedRoute><Layout><DraftsPage /></Layout></ProtectedRoute>} />

        {/* Posting-required Routes (spectators blocked) */}
        <Route path="/category/:categoryId/new-topic" element={<ProtectedRoute requirePosting allowGuest><Layout><TopicFormPage /></Layout></ProtectedRoute>} />

        {/* Admin-only Routes */}
        <Route path="/admin" element={<ProtectedRoute requireAdmin><Layout><AdminPage /></Layout></ProtectedRoute>} />

        {/* Catch all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Mounted OUTSIDE the router, on purpose. A degraded transport is not a
          property of a page: a member reading a topic never opens Notifications,
          but the notification badge in the nav is still quietly ageing on the
          poll. Putting the banner inside a route would have made the warning
          visible only to the members already looking at the affected thing. */}
      <RealtimeStatusBanner uid={user?.uid} />
    </>
  );
};

export default App;
