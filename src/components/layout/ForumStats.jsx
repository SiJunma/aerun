import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, Row, Col } from 'react-bootstrap';
import { Users, FileText, MessageSquare, TrendingUp, History } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { subscribeToActiveUsers, subscribeToActiveGuests, subscribeToDailyActiveUsers, subscribeToAllUsers } from '../../api/auth-resources';
import { CHIEF_ADMIN_ID } from '../../constants/permissions';

// Decoupled stats component
const ForumStats = () => {
  const { t } = useI18n();
  const { user, categories } = useAuth();
  const [activeUsersRaw, setActiveUsersRaw] = useState([]);
  const [activeGuestsRaw, setActiveGuestsRaw] = useState([]);
  const [dailyActiveUsers, setDailyActiveUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]); 
  
  // States for filtered lists (sliding window)

  const [currentTime, setCurrentTime] = useState(() => Date.now());
  
  useEffect(() => {
    const unsubActiveUsers = subscribeToActiveUsers(setActiveUsersRaw);
    const unsubGuests = subscribeToActiveGuests(setActiveGuestsRaw);
    const unsubAllUsers = subscribeToAllUsers(setAllUsers);
    const unsubDailyUsers = subscribeToDailyActiveUsers(setDailyActiveUsers);
    
    // Timer to force re-filtering every 30 seconds (sliding window)
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);
    
    return () => {
      unsubActiveUsers();
      unsubGuests();
      unsubAllUsers();
      unsubDailyUsers();
      clearInterval(timer);
    };
  }, []);

  // Filter users and guests based on a 15-minute window relative to currentTime
  const { onlineUsers, activeGuestsCount } = useMemo(() => {
    const FIFTEEN_MINS_MS = 15 * 60 * 1000;
    const threshold = currentTime - FIFTEEN_MINS_MS;
    
    const filteredUsers = activeUsersRaw.filter(u => {
      const lastSeenMs = u.last_seen?.toMillis?.() || 0;
      return lastSeenMs >= threshold;
    });
    
    const currentGuestId = localStorage.getItem('guest_id');
    
    const filteredGuests = activeGuestsRaw.filter(g => {
      const lastSeenMs = g.last_seen?.toMillis?.() || 0;
      // Exclude current guest ONLY if this specific session is already logged in
      if (user && g.id === currentGuestId) return false;
      return lastSeenMs >= threshold;
    });

    return {
      onlineUsers: filteredUsers,
      activeGuestsCount: filteredGuests.length
    };
  }, [activeUsersRaw, activeGuestsRaw, currentTime, user]);

  // Stats calculation
  const totalTopics = categories.reduce((sum, cat) => sum + (cat.topics_count || 0), 0);
  const totalPosts = categories.reduce((sum, cat) => sum + (cat.posts_count || 0), 0);
  const totalUsers = allUsers.length;
  
  // Newest user (sorted by created_at desc)
  const newestUser = [...allUsers].sort((a, b) => {
    const aTime = a.created_at?.toMillis?.() ?? 0;
    const bTime = b.created_at?.toMillis?.() ?? 0;
    return bTime - aTime;
  })[0];

  return (
    <div className="forum-stats-section mt-5 mb-4">
      <Card className="shadow-sm border-0 forum-stats-card">
      <Card.Header className="stats-header d-flex align-items-center gap-2">
        <span className="forum-header-text">
          {t('stats.title')}
        </span>
        <TrendingUp size={14} className="text-primary opacity-75" />
      </Card.Header>
      <Card.Body className="p-0">
        {/* Main Stats Row - Single Line */}
        <div className="stats-grid p-2 px-3 border-bottom">
          <div className="d-flex flex-wrap align-items-center gap-4 stats-row-compact">
            <div className="d-flex align-items-center gap-2 stats-item">
              <MessageSquare size={14} className="text-muted opacity-50" />
              <div className="d-flex align-items-center gap-1">
                <span className="fw-bold small">{totalTopics.toLocaleString()}</span>
                <span className="text-muted small">{t('stats.topics')}</span>
              </div>
            </div>
            
            <div className="d-flex align-items-center gap-2 stats-item">
              <FileText size={14} className="text-muted opacity-50" />
              <div className="d-flex align-items-center gap-1">
                <span className="fw-bold small">{totalPosts.toLocaleString()}</span>
                <span className="text-muted small">{t('stats.posts')}</span>
              </div>
            </div>

            <div className="d-flex align-items-center gap-2 stats-item">
              <Users size={14} className="text-muted opacity-50" />
              <div className="d-flex align-items-center gap-1">
                <span className="fw-bold small">{totalUsers.toLocaleString()}</span>
                <span className="text-muted small">{t('stats.members')}</span>
              </div>
            </div>

            {newestUser && (
              <div className="d-flex align-items-center gap-2 stats-item ms-auto-md">
                <History size={14} className="text-muted opacity-50" />
                <div className="d-flex align-items-center gap-1">
                  <span className="text-muted small">{t('stats.newest_member')}</span>
                  <Link 
                    to={`/profile/${newestUser.id}`} 
                    className={`online-user-link text-decoration-none fw-bold small ${newestUser.role_id === 'admin' || newestUser.role_id === CHIEF_ADMIN_ID ? 'online-author-admin' : newestUser.role_id === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
                  >
                    {newestUser.nickname}
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Online Users Section */}
        <div className="online-users-panel p-2 px-3">
          <div className="d-flex flex-wrap align-items-center online-list" style={{ gap: '0 4px' }}>
            <span className="text-muted small fw-semibold flex-shrink-0 d-flex align-items-center gap-2 me-1">
              <div className="online-indicator-blob shadow-none" style={{ width: 6, height: 6 }}></div>
              {t('stats.online_now')} ({t('stats.guests')}: {activeGuestsCount}, {t('stats.users')}: {onlineUsers.length}):
            </span>
            {onlineUsers.length === 0 ? (
              <span className="text-muted small italic opacity-75">{t('stats.silence')}</span>
            ) : (
              onlineUsers.map((u, i) => (
                <span key={u.id} className="small">
                  <Link
                    to={`/profile/${u.id}`}
                    className={`online-user-link text-decoration-none ${u.role_id === 'admin' || u.role_id === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role_id === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
                  >
                    {u.nickname}
                  </Link>
                  {i < onlineUsers.length - 1 && <span className="text-muted">,</span>}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Daily Active Users Section */}
        <div className="online-users-panel p-2 px-3" style={{ borderTop: '1px solid rgba(128,128,128,0.15)' }}>
          <div className="d-flex flex-wrap align-items-center online-list" style={{ gap: '0 4px' }}>
            <span className="text-muted small fw-semibold flex-shrink-0 me-1">
              {t('stats.visited_today')} ({dailyActiveUsers.length}):
            </span>
            {dailyActiveUsers.length === 0 ? (
              <span className="text-muted small italic opacity-75">{t('stats.silence')}</span>
            ) : (
              dailyActiveUsers.map((u, i) => (
                <span key={u.id} className="small">
                  <Link
                    to={`/profile/${u.id}`}
                    className={`online-user-link text-decoration-none ${u.role_id === 'admin' || u.role_id === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role_id === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
                  >
                    {u.nickname}
                  </Link>
                  {i < dailyActiveUsers.length - 1 && <span className="text-muted">,</span>}
                </span>
              ))
            )}
          </div>
        </div>


        {/* Footer Links */}
        <div className="stats-footer p-1 px-3 border-top d-flex justify-content-between align-items-center flex-wrap gap-2">
          <Link to="/active-topics" className="btn btn-link btn-xs p-0 text-decoration-none text-primary opacity-50 hover-opacity-100 small">
            {t('stats.active_topics')}
          </Link>
        </div>
        </Card.Body>
      </Card>
    </div>
  );
};

export default ForumStats;
