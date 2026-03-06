import React, { useState, useEffect, useMemo } from 'react';
import { Container, Table, Form, InputGroup, Image, Badge, Row, Col, Card } from 'react-bootstrap';
import { Search, ArrowUpDown, User, Calendar, MessageSquare, Award, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { subscribeToAllUsers } from '../api/forum';
import { formatDistanceToNow, format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const MembersPage = () => {
  const { t, lang } = useI18n();
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('nickname');
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc' or 'desc'

  useEffect(() => {
    const unsub = subscribeToAllUsers(setUsers);
    return () => unsub();
  }, []);

  const formatDate = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const formatLastSeen = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) {
        return lang === 'ru' ? 'Сегодня' : 'Today';
      }
      return format(date, 'd MMM yyyy', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const sortedAndFilteredUsers = useMemo(() => {
    let result = users.filter(u =>
      u.nickname?.toLowerCase().includes(search.toLowerCase()) ||
      u.email?.toLowerCase().includes(search.toLowerCase())
    );

    result.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      // Handle nested or complex fields if necessary
      if (sortField === 'created_at' || sortField === 'last_seen' || sortField === 'updated_at') {
        aVal = a[sortField]?.toMillis?.() || 0;
        bVal = b[sortField]?.toMillis?.() || 0;
      }

      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [users, search, sortField, sortOrder]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const getRoleBadge = (role) => {
    if (role === 'admin') return <Badge bg="danger">Admin</Badge>;
    if (role === 'moderator') return <Badge bg="warning" text="dark">Moderator</Badge>;
    return <Badge bg="secondary">Member</Badge>;
  };

  return (
    <Container className="py-4">
      <div className="mb-4">
        <h2 className="mb-2 d-flex align-items-center gap-2">
          <User size={28} className="text-primary" />
          {t('nav.members')}
          <Badge bg="primary" pill className="ms-2" style={{ fontSize: '0.9rem' }}>
            {users.length}
          </Badge>
        </h2>
        <p className="text-muted">
          {lang === 'ru' ? 'Список всех зарегистрированных участников форума' : 'List of all registered forum participants'}
        </p>
      </div>

      <Card className="shadow-sm border-0 mb-4" style={{ background: 'rgba(255, 255, 255, 0.03)', backdropFilter: 'blur(10px)' }}>
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
            <Col md={5} className="text-md-end">
              <span className="text-muted small me-2">{lang === 'ru' ? 'Сортировка:' : 'Sort by:'}</span>
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
                <option value="post_count-desc">{lang === 'ru' ? 'Больше постов' : 'Most Posts'}</option>
                <option value="reputation-desc">{lang === 'ru' ? 'Выше репутация' : 'Highest Rep'}</option>
                <option value="created_at-desc">{lang === 'ru' ? 'Новые участники' : 'Newest'}</option>
                <option value="created_at-asc">{lang === 'ru' ? 'Старые участники' : 'Oldest'}</option>
              </Form.Select>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      <div className="table-responsive rounded shadow-sm overflow-hidden members-table-container">
        <Table className="align-middle mb-0 border-0">
          <thead className="small text-muted text-uppercase fw-bold members-table-head">
            <tr>
              <th className="py-3 ps-4" style={{ width: '30%', border: 'none' }}>{lang === 'ru' ? 'Участник' : 'Member'}</th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>{lang === 'ru' ? 'Роль' : 'Role'}</th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer" onClick={() => handleSort('created_at')}>
                  {lang === 'ru' ? 'Регистрация' : 'Joined'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '20%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer" onClick={() => handleSort('last_seen')}>
                  {lang === 'ru' ? 'Активность' : 'Last Seen'}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3 text-center" style={{ width: '10%', border: 'none' }}>
                <div className="d-flex align-items-center justify-content-center gap-1 cursor-pointer" onClick={() => handleSort('post_count')}>
                  <MessageSquare size={14} />
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3 text-center pe-4" style={{ width: '10%', border: 'none' }}>
                <div className="d-flex align-items-center justify-content-center gap-1 cursor-pointer" onClick={() => handleSort('reputation')}>
                  <Award size={14} />
                  <ArrowUpDown size={12} />
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="border-0">
            {sortedAndFilteredUsers.length > 0 ? (
              sortedAndFilteredUsers.map(u => (
                <tr key={u.id} className="align-middle members-table-row">
                  <td className="ps-4 py-3 border-0">
                    <div className="d-flex align-items-center gap-3">
                      <Image
                        src={u.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.nickname || 'U')}&background=random`}
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
                  <td className="border-0">{getRoleBadge(u.role_id)}</td>
                  <td className="small text-muted border-0">
                    <div className="d-flex align-items-center gap-1">
                      <Calendar size={14} />
                      {formatDate(u.created_at || u.registered_at || u.joined_at)}
                    </div>
                  </td>
                  <td className="small text-muted border-0">
                    <div className="d-flex align-items-center gap-1">
                      <Clock size={14} />
                      {formatLastSeen(u.last_seen || u.updated_at || u.created_at)}
                    </div>
                  </td>
                  <td className="text-center fw-semibold text-primary border-0">{u.post_count || 0}</td>
                  <td className="text-center pe-4 border-0">
                    <Badge bg="light" text="dark" className="border">
                      {u.reputation || 0}
                    </Badge>
                  </td>
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
