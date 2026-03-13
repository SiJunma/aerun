import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Card, Row, Col } from 'react-bootstrap';
import { Users, FileText, MessageSquare, TrendingUp, History } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { subscribeToCategories, subscribeToAllUsers } from '../../api/forum';

const ForumStats = () => {
  const { t, lang } = useI18n();
  const [categories, setCategories] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  
  useEffect(() => {
    const unsubCats = subscribeToCategories(setCategories);
    const unsubUsers = subscribeToAllUsers(setAllUsers);
    return () => {
      unsubCats();
      unsubUsers();
    };
  }, []);

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

  // Online users (last 15 mins)
  const now = Date.now();
  const FIFTEEN_MINS = 15 * 60 * 1000;
  const onlineUsers = allUsers.filter(u => {
    const lastSeen = u.last_seen?.toMillis?.() ?? 0;
    return (now - lastSeen) < FIFTEEN_MINS;
  }).sort((a, b) => a.nickname.localeCompare(b.nickname));

  return (
    <div className="forum-stats-section mt-5 mb-4">
      <Card className="shadow-sm border-0 forum-stats-card">
      <Card.Header className="stats-header py-1 px-3 d-flex align-items-center gap-2">
        <TrendingUp size={14} className="text-primary opacity-75" />
        <span className="fw-bold small text-uppercase letter-spacing-1 opacity-75">
          {t('stats.title')}
        </span>
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
                    className={`online-user-link text-decoration-none fw-bold small ${newestUser.role_id === 'admin' ? 'online-author-admin' : newestUser.role_id === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
                  >
                    {newestUser.nickname}
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Online Users Section */}
        <div className="online-users-panel p-2 px-3 bg-light-subtle">
          <div className="d-flex align-items-center gap-2 mb-1">
            <div className="online-indicator-blob shadow-none" style={{ width: 6, height: 6 }}></div>
            <span className="text-muted small fw-semibold">
              {t('stats.online_now')}: {onlineUsers.length}
            </span>
          </div>
          <div className="online-list">
            {onlineUsers.length === 0 ? (
               <span className="text-muted small italic opacity-75">{t('stats.silence')}</span>
            ) : (
              <div className="d-flex flex-wrap gap-2">
                {onlineUsers.map((u) => (
                  <Link 
                    key={u.id}
                    to={`/profile/${u.id}`} 
                    className={`online-user-link small text-decoration-none fw-bold ${u.role_id === 'admin' ? 'online-author-admin' : u.role_id === 'moderator' ? 'online-author-mod' : 'text-primary'}`}
                  >
                    {u.nickname}
                  </Link>
                ))}
              </div>
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
