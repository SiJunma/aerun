import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card } from 'react-bootstrap';
import { Users, FileText, MessageSquare, TrendingUp, History } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { subscribeToActiveGuestsRtdb } from '../../api/rtdb-presence';
import { CHIEF_ADMIN_ID } from '../../constants/permissions';

const ForumStats = () => {
  const { t } = useI18n();
  const { user, categories, activeUsers, forumStats, dailyActiveUsers: contextDailyUsers } = useAuth();

  const [activeGuestsRaw, setActiveGuestsRaw] = useState([]);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  
  useEffect(() => {
    const unsubGuests = subscribeToActiveGuestsRtdb(setActiveGuestsRaw);

    // Таймер для скользящего окна отсечения гостей (раз в 30 секунд)
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);

    return () => {
      unsubGuests();
      clearInterval(timer);
    };
  }, []);


  // Онлайн пользователи и гости
  const { onlineUsers, activeGuestsCount } = useMemo(() => {
    const FIFTEEN_MINS_MS = 15 * 60 * 1000;
    const threshold = currentTime - FIFTEEN_MINS_MS;
    const currentGuestId = localStorage.getItem('guest_id');
    
    const filteredGuests = activeGuestsRaw.filter(g => {
      const lastSeenMs = typeof g.last_seen === 'number'
        ? g.last_seen
        : (g.last_seen?.toMillis ? g.last_seen.toMillis() : (typeof g.last_seen === 'string' ? new Date(g.last_seen).getTime() : 0));
      if (user && g.id === currentGuestId) return false;
      return lastSeenMs >= threshold;
    });

    return {
      onlineUsers: activeUsers,
      activeGuestsCount: filteredGuests.length
    };
  }, [activeUsers, activeGuestsRaw, currentTime, user]);

  // "Visited today" is a DIFFERENT clock from the list above it, and it used to
  // be the same array: subscribeToDailyActiveUsers was a one-line alias of the
  // online subscription, so the panel printed the connected-now members twice
  // under two labels, and anyone who had visited earlier and left read as
  // "not active today".
  //
  // Both halves now come from the server: the NAMES from
  // stats.dailyActiveUsers (users.last_seen inside a 24h window, the durable
  // column) and the COUNT from stats.dailyActiveUserCount, which stays exact
  // even when the name list is capped for rendering. A member who signed out a
  // minute ago belongs here and no longer belongs above — that difference is
  // the whole reason the row exists.
  const dailyActiveUsers = forumStats?.dailyActiveUsers || contextDailyUsers || [];
  const dailyActiveCount = forumStats?.dailyActiveUserCount ?? dailyActiveUsers.length;
  const totalTopics = forumStats?.totalTopics ?? categories.reduce((sum, cat) => sum + (cat.topics_count || 0), 0);
  const totalPosts = forumStats?.totalPosts ?? categories.reduce((sum, cat) => sum + (cat.posts_count || 0), 0);
  const totalUsers = forumStats?.totalUsers ?? 0;
  const newestUser = forumStats?.newestUser ?? null;

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
                      className={`online-user-link text-decoration-none fw-bold small ${newestUser.role === 'admin' || newestUser.role === CHIEF_ADMIN_ID ? 'online-author-admin' : newestUser.role === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
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
                      className={`online-user-link text-decoration-none ${u.role === 'admin' || u.role === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
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
                {t('stats.visited_today')} ({dailyActiveCount}):
              </span>
              {dailyActiveUsers.length === 0 ? (
                <span className="text-muted small italic opacity-75">{t('stats.silence')}</span>
              ) : (
                dailyActiveUsers.map((u, i) => (
                  <span key={u.id} className="small">
                    <Link
                      to={`/profile/${u.id}`}
                      className={`online-user-link text-decoration-none ${u.role === 'admin' || u.role === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
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