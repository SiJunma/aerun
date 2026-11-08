import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users, FileText, MessageSquare, TrendingUp, History } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { subscribeToActiveGuestsRtdb } from '../../api/rtdb-presence';
import { CHIEF_ADMIN_ID } from '../../constants/permissions';

const ForumStats = () => {
  const { t } = useI18n();
  const { categories, activeUsers, forumStats, dailyActiveUsers: contextDailyUsers } = useAuth();

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

    // No local masking. The old `if (user && g.id === currentGuestId) return
    // false` hid the browser's own guest row only on the tab that happened to
    // share the same localStorage — on a second monitor, in a private window
    // or on a phone the same guest was counted (AUDIT §3.1). The server
    // already removes the guest row when the visitor logs in, so whatever
    // remains in guest_presence is a real guest and is counted as one.
    const filteredGuests = activeGuestsRaw.filter(g => {
      const lastSeenMs = typeof g.last_seen === 'number'
        ? g.last_seen
        : (g.last_seen?.toMillis ? g.last_seen.toMillis() : (typeof g.last_seen === 'string' ? new Date(g.last_seen).getTime() : 0));
      return lastSeenMs >= threshold;
    });

    return {
      onlineUsers: activeUsers,
      activeGuestsCount: filteredGuests.length
    };
  }, [activeUsers, activeGuestsRaw, currentTime]);

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
    <section id="forum-statistics" className="forum-statistics mt-5 mb-4">
      <div className="forum-stats-card">
        <header className="stats-header">
          <span className="stats-title">
            {t('stats.title')}
          </span>
          <TrendingUp size={14} className="stats-header-icon" />
        </header>

        <div className="stats-body">
          <div className="stats-grid">
            <div className="stats-row-compact">
              <div className="stats-item stat-topics">
                <MessageSquare size={14} className="stats-item-icon" />
                <div className="stats-item-text-group">
                  <span className="stat-count">{totalTopics.toLocaleString()}</span>
                  <span className="stat-label">{t('stats.topics')}</span>
                </div>
              </div>
              
              <div className="stats-item stat-posts">
                <FileText size={14} className="stats-item-icon" />
                <div className="stats-item-text-group">
                  <span className="stat-count">{totalPosts.toLocaleString()}</span>
                  <span className="stat-label">{t('stats.posts')}</span>
                </div>
              </div>

              <div className="stats-item stat-members">
                <Users size={14} className="stats-item-icon" />
                <div className="stats-item-text-group">
                  <span className="stat-count">{totalUsers.toLocaleString()}</span>
                  <span className="stat-label">{t('stats.members')}</span>
                </div>
              </div>

              {newestUser && (
                <div className="stats-item stat-newest-member ms-auto-md">
                  <History size={14} className="stats-item-icon" />
                  <div className="stats-item-text-group">
                    <span className="stat-label">{t('stats.newest_member')}</span>
                    <Link 
                      to={`/profile/${newestUser.id}`} 
                      className={`online-user-link ${newestUser.role === 'admin' || newestUser.role === CHIEF_ADMIN_ID ? 'online-author-admin' : newestUser.role === 'moderator' ? 'online-author-mod' : 'stat-user-default'}`}
                    >
                      {newestUser.nickname}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Online Users Section */}
          <div className="online-users-panel stat-online">
            <div className="online-list">
              <span className="online-list-label">
                <div className="online-indicator-blob"></div>
                {t('stats.online_now')} ({t('stats.guests')}: {activeGuestsCount}, {t('stats.users')}: {onlineUsers.length}):
              </span>
              {onlineUsers.length === 0 ? (
                <span className="stat-silence">{t('stats.silence')}</span>
              ) : (
                onlineUsers.map((u, i) => (
                  <span key={u.id} className="online-user-entry">
                    <Link
                      to={`/profile/${u.id}`}
                      className={`online-user-link ${u.role === 'admin' || u.role === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role === 'moderator' ? 'online-author-mod' : 'stat-user-default'}`}
                    >
                      {u.nickname}
                    </Link>
                    {i < onlineUsers.length - 1 && <span className="online-separator">,</span>}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Daily Active Users Section */}
          <div className="online-users-panel stat-visited-today">
            <div className="online-list">
              <span className="online-list-label">
                {t('stats.visited_today')} ({dailyActiveCount}):
              </span>
              {dailyActiveUsers.length === 0 ? (
                <span className="stat-silence">{t('stats.silence')}</span>
              ) : (
                dailyActiveUsers.map((u, i) => (
                  <span key={u.id} className="online-user-entry">
                    <Link
                      to={`/profile/${u.id}`}
                      className={`online-user-link ${u.role === 'admin' || u.role === CHIEF_ADMIN_ID ? 'online-author-admin' : u.role === 'moderator' ? 'online-author-mod' : 'stat-user-default'}`}
                    >
                      {u.nickname}
                    </Link>
                    {i < dailyActiveUsers.length - 1 && <span className="online-separator">,</span>}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Footer Links */}
          <div className="stats-footer">
            <Link to="/active-topics" className="stats-footer-link">
              {t('stats.active_topics')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ForumStats;