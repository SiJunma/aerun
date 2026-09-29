import React, { useState, useEffect, useMemo } from 'react';
import { Container, Table, Form, InputGroup, Image, Badge, Row, Col, Card } from 'react-bootstrap';
import { Search, ArrowUpDown, User, Calendar, MessageSquare, Award, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToAllUsers } from '../api/auth-resources';
import { subscribeToRtdbStatuses } from '../api/rtdb-presence';
import { resolveAvatarUrl } from '../api/avatars';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import Timestamp from '../components/common/Timestamp';

const ROLE_PRIORITY = {
  'root': 120,
  'admin': 100,
  'moderator': 80,
  'player': 60,
  'banned': 40,
  'pending': 20
};

import { usePageTitle } from '../contexts/TitleProvider';

const MembersPage = () => {
  const { t, lang } = useI18n();
  const { profile, updateSettings, settings } = useAuth();
  const { setPageTitle } = usePageTitle();
  const [users, setUsers] = useState([]);
  const [rtdbStatuses, setRtdbStatuses] = useState({});
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('nickname');
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc' or 'desc'

  useEffect(() => {
    setPageTitle(t('nav.members', 'Участники'));
  }, [setPageTitle, t, lang]);
  
  // Use profile setting with a fallback to local state for instant UI update
  const [isStacked, setIsStacked] = useState(profile?.settings?.member_view_style === 'stacked');

  // Keep local state in sync if profile changes (e.g., from another tab)
  useEffect(() => {
    if (profile?.settings?.member_view_style) {
      setTimeout(() => setIsStacked(profile.settings.member_view_style === 'stacked'), 0);
    }
  }, [profile?.settings?.member_view_style]);

  const handleToggleStacked = async (checked) => {
    const newStyle = checked ? 'stacked' : 'table';
    setIsStacked(checked);
    if (updateSettings) {
      await updateSettings({ member_view_style: newStyle });
    }
  };

  useEffect(() => {
    const unsubUsers = subscribeToAllUsers(setUsers);
    const unsubStatuses = subscribeToRtdbStatuses(setRtdbStatuses);
    return () => {
      unsubUsers();
      unsubStatuses();
    };
  }, []);

  const formatDate = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return <Timestamp date={date} />;
    } catch {
      return '...';
    }
  };

  const getUserLastSeen = (u) => {
    const rtdb = rtdbStatuses[u.id] || rtdbStatuses[u.uid];
    if (rtdb) {
      const lastActive = typeof rtdb.last_activity === 'number'
        ? rtdb.last_activity
        : (typeof rtdb.last_seen === 'number'
            ? rtdb.last_seen
            : (rtdb.last_activity ? new Date(rtdb.last_activity).getTime() : (rtdb.last_seen ? new Date(rtdb.last_seen).getTime() : 0))
          );
      if (lastActive > 0) return lastActive;
    }
    return u.last_seen || u.updated_at || u.created_at;
  };

  const formatLastSeen = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return <Timestamp date={date} />;
    } catch {
      return '...';
    }
  };

  const sortedAndFilteredUsers = useMemo(() => {
    let result = users.filter(u =>
      u.nickname?.toLowerCase().includes(search.toLowerCase())
    );

    result.sort((a, b) => {
      let aVal, bVal;

      if (sortField === 'role_id') {
        aVal = ROLE_PRIORITY[a.role_id] || 60;
        bVal = ROLE_PRIORITY[b.role_id] || 60;
      } else if (sortField === 'last_seen') {
        const aSeen = getUserLastSeen(a);
        const bSeen = getUserLastSeen(b);
        aVal = typeof aSeen === 'number' ? aSeen : (aSeen?.toMillis?.() || (aSeen ? new Date(aSeen).getTime() : 0));
        bVal = typeof bSeen === 'number' ? bSeen : (bSeen?.toMillis?.() || (bSeen ? new Date(bSeen).getTime() : 0));
      } else if (sortField === 'created_at' || sortField === 'updated_at') {
        aVal = a[sortField]?.toMillis?.() || 0;
        bVal = b[sortField]?.toMillis?.() || 0;
      } else {
        aVal = a[sortField];
        bVal = b[sortField];

        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      }

      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
      
      // Secondary sort by nickname to keep list stable
      const nameA = (a.nickname || '').toLowerCase();
      const nameB = (b.nickname || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return result;
  }, [users, rtdbStatuses, search, sortField, sortOrder]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // Default to desc for count/date fields, asc for text
      if (['post_count', 'reputation', 'created_at', 'last_seen', 'role_id'].includes(field)) {
        setSortOrder('desc');
      } else {
        setSortOrder('asc');
      }
    }
  };

  const getRoleBadge = (u) => (
    <ForumRoleBadge
      roleId={u.role_id}
      userEmail={u.email}
    />
  );

  return (
    <Container className="py-4">
      <ForumBreadcrumbs 
        items={[{ label: t('nav.members'), active: true }]} 
      />
      <div className="mb-4">
        <h2 className="mb-2 d-flex align-items-center gap-2">
          <User size={28} className="text-primary" />
          {t('nav.members')}
          <Badge bg="none" pill className="ms-2 badge-premium" style={{ fontSize: '0.85rem', padding: '0.35em 0.8em' }}>
            {users.length}
          </Badge>
        </h2>
        <p className="text-muted">
          {lang === 'ru' ? 'Список всех зарегистрированных участников форума' : 'List of all registered forum participants'}
        </p>
      </div>

      <Card className="shadow-sm border-0 mb-4 bg-card">
        <Card.Body className="p-3">
          <Row className="g-3 align-items-center">
            <Col md={7}>
              <InputGroup className="shadow-sm">
                <InputGroup.Text className="border-end-0 pe-1">
                  <Search size={18} />
                </InputGroup.Text>
                <Form.Control
                  placeholder={lang === 'ru' ? 'Поиск по нику...' : 'Search by nickname...'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="border-start-0 ps-2"
                  style={{ boxShadow: 'none' }}
                />
              </InputGroup>
            </Col>
            <Col md={5} className="d-flex align-items-center justify-content-lg-end gap-3 flex-wrap">
              <div className="d-lg-none d-flex align-items-center gap-2 border-end pe-3 me-1">
                <Form.Check
                  type="switch"
                  id="stack-toggle"
                  label={isStacked ? t('forum.table_view') : t('forum.stacked_view')}
                  checked={isStacked}
                  onChange={(e) => handleToggleStacked(e.target.checked)}
                  className="small fw-bold text-muted mb-0"
                />
              </div>
              <div className="d-flex align-items-center gap-2">
                <span className="text-muted small me-1">{lang === 'ru' ? 'Сортировка:' : 'Sort by:'}</span>
                <Form.Select
                  size="sm"
                  className="d-inline-block w-auto shadow-sm"
                  value={`${sortField}-${sortOrder}`}
                  onChange={(e) => {
                    const [field, order] = e.target.value.split('-');
                    setSortField(field);
                    setSortOrder(order);
                  }}
                >
                  <option value="nickname-asc">{lang === 'ru' ? 'Имя (A-Z)' : 'Name (A-Z)'}</option>
                  <option value="nickname-desc">{lang === 'ru' ? 'Имя (Z-A)' : 'Name (Z-A)'}</option>
                  <option value="role_id-desc">{lang === 'ru' ? 'Ранг (по убыванию)' : 'Rank (Desc)'}</option>
                  <option value="role_id-asc">{lang === 'ru' ? 'Ранг (по возрастанию)' : 'Rank (Asc)'}</option>
                  <option value="post_count-desc">{lang === 'ru' ? 'Больше постов' : 'Most Posts'}</option>
                  <option value="post_count-asc">{lang === 'ru' ? 'Меньше постов' : 'Fewest Posts'}</option>
                  <option value="reputation-desc">{lang === 'ru' ? 'Выше репутация' : 'Highest Rep'}</option>
                  <option value="reputation-asc">{lang === 'ru' ? 'Ниже репутация' : 'Lowest Rep'}</option>
                  <option value="last_seen-desc">{lang === 'ru' ? 'Сначала активные' : 'Recently Active'}</option>
                  <option value="last_seen-asc">{lang === 'ru' ? 'Сначала неактивные' : 'Least Recently Active'}</option>
                  <option value="created_at-desc">{lang === 'ru' ? 'Сначала новые' : 'Newest First'}</option>
                  <option value="created_at-asc">{lang === 'ru' ? 'Сначала старые' : 'Oldest First'}</option>
                </Form.Select>
              </div>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      <div className={`table-responsive rounded shadow-sm ${isStacked ? 'members-table-stacked-container' : 'members-table-container'}`}>
        <Table className={`align-middle mb-0 border-0 ${isStacked ? 'members-table-stacked' : ''}`}>
          <thead className="small text-muted text-uppercase fw-bold members-table-head">
            <tr>
              <th className="py-3 ps-4" style={{ width: '30%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('nickname')}>
                  {lang === 'ru' ? 'Участник' : 'Member'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('role_id')}>
                  {lang === 'ru' ? 'Роль' : 'Role'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('created_at')}>
                  {lang === 'ru' ? 'Регистрация' : 'Joined'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '20%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('last_seen')}>
                  {lang === 'ru' ? 'Активность' : 'Last Seen'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3 text-center" style={{ width: '10%', border: 'none' }}>
                <div className="d-flex align-items-center justify-content-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('post_count')}>
                  <MessageSquare size={14} />
                  <ArrowUpDown size={12} />
                </div>
              </th>
              {settings?.enableReputation && (
                <th className="py-3 text-center pe-4" style={{ width: '10%', border: 'none' }}>
                  <div className="d-flex align-items-center justify-content-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('reputation')}>
                    <Award size={14} />
                    <ArrowUpDown size={12} />
                  </div>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="border-0">
            {sortedAndFilteredUsers.length > 0 ? (
              sortedAndFilteredUsers.map(u => (
                <tr key={u.id} className="align-middle members-table-row">
                  <td className="ps-4 py-3 border-0" data-label={lang === 'ru' ? 'Участник' : 'Member'}>
                    <div className="d-flex align-items-center gap-3">
                      <Image
                        src={resolveAvatarUrl(u.avatar_url) || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.nickname || 'U')}&background=random`}
                        roundedCircle
                        style={{ width: '40px', height: '40px', objectFit: 'cover' }}
                        onError={(e) => {
                          e.target.onerror = null;
                          e.target.src = 'https://ui-avatars.com/api/?name=User&background=666&color=fff';
                        }}
                      />
                      <div className="text-truncate">
                        <Link to={`/profile/${u.id}`} className="fw-bold text-decoration-none d-block text-truncate member-nickname" style={{ color: 'var(--primary-color)', fontSize: '1.05rem', transition: 'all 0.2s' }}>
                          {u.nickname || 'User'}
                        </Link>
                        {u.status_line && (
                          <small className="text-muted d-block text-truncate" style={{ maxWidth: '180px' }}>
                            {u.status_line}
                          </small>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="border-0" data-label={lang === 'ru' ? 'Роль' : 'Role'}>{getRoleBadge(u)}</td>
                  <td className="small text-muted border-0" data-label={lang === 'ru' ? 'Регистрация' : 'Joined'}>
                    <div className="d-flex align-items-center gap-1">
                      <Calendar size={14} className="flex-shrink-0" />
                      {formatDate(u.created_at || u.registered_at || u.joined_at)}
                    </div>
                  </td>
                  <td className="small text-muted border-0" data-label={lang === 'ru' ? 'Активность' : 'Last Seen'}>
                    <div className="d-flex align-items-center gap-1">
                      <Clock size={14} className="flex-shrink-0" />
                      {formatLastSeen(getUserLastSeen(u))}
                    </div>
                  </td>
                  <td className="text-center fw-semibold text-primary border-0" data-label={lang === 'ru' ? 'Посты' : 'Posts'}>{u.post_count || 0}</td>
                  {settings?.enableReputation && (
                    <td className="text-center pe-4 border-0" data-label={lang === 'ru' ? 'Репутация' : 'Rep'}>
                      <Badge bg="light" text="dark" className="border">
                        {u.reputation || 0}
                      </Badge>
                    </td>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="6" className="text-center py-5 text-muted border-0">
                  {lang === 'ru' ? 'Участники не найдены' : 'No members found'}
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
    </Container>
  );
};

export default MembersPage;
