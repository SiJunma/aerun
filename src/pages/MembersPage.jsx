import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Container, Table, Form, InputGroup, Image, Badge, Row, Col, Card, Button } from 'react-bootstrap';
import { Search, ArrowUpDown, User, Calendar, MessageSquare, Award, Clock, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToAllUsers } from '../api/auth-resources';
import { subscribeToRtdbStatuses } from '../api/rtdb-presence';
import { resolveAvatarUrl } from '../api/avatars';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import { getRoleVisuals, resolveUserRoleId } from '../constants/permissions';
import Timestamp from '../components/common/Timestamp';
import { toMillis as sharedToMillis } from '../utils/dates';

// The two legacy pseudo-roles. They cannot reach the role sort as role ids any
// more -- users.role is validated against the roles registry and the
// active/pending/banned lifecycle moved to users.status -- but the badge still
// special-cases them, so the sort has to agree with the badge rather than let
// getRoleVisuals fall back to "Player" and sort a Banned account under a name
// it is not wearing.
const LEGACY_PSEUDO_ROLE_LABELS = {
  banned: 'Banned',
  pending: 'Pending',
  deleted: 'Deleted'
};

import { usePageTitle } from '../contexts/TitleProvider';
import { useToast } from '../contexts/ToastProvider';

const MembersPage = () => {
  const { t, lang } = useI18n();
  const { profile, updateSettings, settings, roles } = useAuth();
  const { setPageTitle } = usePageTitle();
  const { showToast } = useToast();
  const [users, setUsers] = useState([]);
  const [rtdbStatuses, setRtdbStatuses] = useState({});
  const [search, setSearch] = useState('');
  // Default order is most recently active first. The members table exists to
  // answer "who is around", so activity is the useful default rather than the
  // alphabetical one; `last_seen-desc` is a real entry in the sort dropdown, so
  // the control still shows the active state on first paint.
  const [sortField, setSortField] = useState('last_seen');
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'

  // The board is a directory, and it is polled — deliberately, per
  // REALTIME_TRANSPORT_DESIGN.md: a realtime subscription over every account
  // would stream the whole membership to every visitor. So "is this list
  // current?" is a question the page cannot answer by itself, and the member
  // needs a way to ask it that is not "reload the tab" or "walk to another page
  // and back" — the two workarounds this button replaces.
  //
  // The ref, not state: `refresh` is a function handed over by the subscription
  // in an effect, and putting it in state would re-render the whole board the
  // moment it is assigned.
  const refreshMembersRef = useRef(null);
  // Mirrors `users` for reads that happen OUTSIDE a render — the toast callback
  // runs on a timer, and closing over `users` there would read the array as it
  // was when the button was clicked, so a refresh that actually changed the
  // count would still report the old one.
  const usersRef = useRef(users);
  useEffect(() => { usersRef.current = users; }, [users]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);

    // The toast carries the ANSWER, not the click. A spinner that stops proves
    // the request returned, not that it succeeded — and this list fails quietly:
    // `subscribeToAllUsers` swallows a failed read into `callback([])`, so a
    // network blip empties the board with no error anywhere. Saying "the list is
    // up to date" unconditionally would therefore be a lie exactly when it
    // matters most.
    //
    // So the count before and after is the evidence: if it changed, the board
    // really was stale and the refresh did something.
    const before = users.length;
    try {
      refreshMembersRef.current?.();
      setTimeout(() => {
        setIsRefreshing(false);
        const after = usersRef.current.length;
        if (after === 0 && before > 0) {
          showToast(
            lang === 'ru' ? 'Не удалось загрузить список участников' : 'Could not load the members list',
            'danger'
          );
          return;
        }
        showToast(
          lang === 'ru'
            ? `Список обновлён · участников: ${after}`
            : `List refreshed · ${after} members`,
          'success'
        );
      }, 600);
    } catch {
      setIsRefreshing(false);
      showToast(
        lang === 'ru' ? 'Не удалось обновить список' : 'Could not refresh the list',
        'danger'
      );
    }
  };

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
    // Held, not called here: the button reads it later, and calling it on mount
    // would double the very first load this effect already performs.
    refreshMembersRef.current = unsubUsers.refresh;
    const unsubStatuses = subscribeToRtdbStatuses(setRtdbStatuses);
    return () => {
      unsubUsers();
      unsubStatuses();
      refreshMembersRef.current = null;
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

  // toMillis normalises anything date-shaped into epoch ms, or 0 when there is
  // no usable value. `last_seen` arrives as an ISO string from the staff DTO
  // and as epoch ms from the live presence cache, so both spellings have to be
  // accepted in one place rather than at each call site.
  //
  // It is the shared `toMillis`, not a third local copy: the local version fed
  // `Date.parse` PocketBase's space-instead-of-"T" form raw, and an engine that
  // reads that as local time shifts the instant by the whole UTC offset — which
  // is how a member who is online right now gets a LAST SEEN reading in the
  // future.
  const toMillis = (value) => sharedToMillis(value);

  // getUserLastSeen resolves the LAST SEEN column through three sources, most
  // precise first.
  //
  // This chain is what makes the column non-empty. It previously had exactly
  // one working source — the live presence cache — and that cache is a
  // deliberately disposable in-process map that drops a member 75 seconds after
  // their last heartbeat (and is empty entirely after a server restart). So the
  // column was blank for every member who was not connected at that instant,
  // which is nearly all of them, and the "..." was not a transient state but
  // the permanent resting state of the column.
  //
  //   1. Live presence. Exact to the last beat, but only while connected.
  //   2. users.last_seen. The durable last-visit clock the backend persists
  //      (migration 1767300000, written by the heartbeat and by registration).
  //      This is the real answer for an offline member.
  //   3. created_at. Registration is itself real activity, so this is a true
  //      lower bound rather than a placeholder — the one case where the column
  // can legitimately show the account's age and nothing more.
  //
  // `updated_at` is deliberately NOT in the chain: it is a record edit time and
  // moves on every import and settings write, so it would confidently display
  // the date of the last import as if it were the date the person was last
  // seen. That is why the backend grew a real column instead.
  // getUserLastSeen is memoised because the sorted/filtered list below depends
  // on it: without useCallback it is a new function on every render, so the
  // useMemo would be invalidated on every render and stop memoising anything.
  // Its only closure is rtdbStatuses, so the memo invalidates exactly when the
  // presence snapshot does — the same cadence the old dependency list gave by
  // accident.
  const getUserLastSeen = useCallback((u) => {
    const live = rtdbStatuses[u.id] || rtdbStatuses[u.uid];
    if (live) {
      const lastActive = toMillis(live.last_activity) || toMillis(live.last_seen);
      if (lastActive > 0) return lastActive;
    }
    return toMillis(u.last_seen) || toMillis(u.created_at ?? u.created) || 0;
  }, [rtdbStatuses]);

  const formatLastSeen = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return <Timestamp date={date} />;
    } catch {
      return '...';
    }
  };

  // roleLabel returns the exact string the role badge renders for a member, so
  // that sorting by role and reading the column can never disagree.
  //
  // It deliberately goes through the same two resolvers ForumRoleBadge uses --
  // resolveUserRoleId for the root alias, getRoleVisuals for the registry row
  // and its Player fallback. Calling them here rather than reimplementing the
  // lookup is the point: the previous hardcoded ROLE_PRIORITY table ranked
  // roles by permission weight instead of by the label on screen, and it only
  // knew the six compiled system roles, so every imported custom role
  // (NorthbayCitizen, Demon, Anaptix, ...) missed the lookup and was pinned to
  // 60 -- all of them tied with player, with their real order then decided by
  // the nickname tiebreak.
  const roleLabel = useCallback((u) => {
    const pseudo = LEGACY_PSEUDO_ROLE_LABELS[u.role_id];
    if (pseudo) return pseudo;
    return getRoleVisuals(resolveUserRoleId(u.email, u.role_id), roles).name;
  }, [roles]);

  const sortedAndFilteredUsers = useMemo(() => {
    let result = users.filter(u =>
      u.nickname?.toLowerCase().includes(search.toLowerCase())
    );

    result.sort((a, b) => {
      let aVal, bVal;

      if (sortField === 'role_id') {
        // Alphabetical by the rendered label, and it has to be its own compare:
        // the generic branch below orders with < / >, which is a code-unit
        // comparison. That sorts by UTF-16 unit, so "NorthbayСitizen" (Cyrillic
        // С, an imported custom role) lands after every Latin letter rather
        // than beside its Latin twin, which reads as random. localeCompare is
        // collation-aware and treats case and accents as equal.
        const cmp = roleLabel(a).localeCompare(roleLabel(b), undefined, { sensitivity: 'base' });
        if (cmp !== 0) return sortOrder === 'asc' ? cmp : -cmp;
        // Same fixed nickname tiebreak the other columns use, so a group of
        // members sharing a role label still reads in a stable order.
        return (a.nickname || '').toLowerCase().localeCompare((b.nickname || '').toLowerCase());
      }

      if (sortField === 'last_seen') {
        // getUserLastSeen already normalises to epoch ms, so the sort compares
        // two plain numbers instead of re-deriving the value at a second call
        // site (which is how the two spellings drifted apart before).
        aVal = getUserLastSeen(a);
        bVal = getUserLastSeen(b);
      } else if (sortField === 'created_at' || sortField === 'updated_at') {
        // toMillis, not `?.[sortField]?.toMillis?.() || 0`. The members row
        // carries created_at as an ISO *string* (withLegacyDates normalises
        // PocketBase's "YYYY-MM-DD HH:MM:SS.sssZ" into it), so it has no
        // toMillis method at all: the optional call silently short-circuited to
        // undefined, the `|| 0` turned every row into 0, and the comparator
        // then saw "all equal" and fell through to the nickname tiebreak. In
        // other words Newest/Oldest First did nothing at all and just re-sorted
        // by name -- which reads as "the sort is broken" without ever looking
        // broken. The rows also carry the same value under the bare `created`
        // key, so that spelling is accepted as a fallback.
        aVal = toMillis(a[sortField]) || toMillis(a[sortField.replace(/_at$/, '')]);
        bVal = toMillis(b[sortField]) || toMillis(b[sortField.replace(/_at$/, '')]);
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
  }, [users, getUserLastSeen, roleLabel, search, sortField, sortOrder]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // Default to desc for count/date fields, asc for text. role_id is a text
      // sort now (alphabetical by the rendered label), so it belongs with the
      // ascending group: opening it on Z-A would put the rarest label first for
      // no reason.
      if (['post_count', 'reputation', 'created_at', 'last_seen'].includes(field)) {
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
                  {/* Activity first: it is the default order, so the control opens
                      on the option that is actually in effect. */}
                  <option value="last_seen-desc">{lang === 'ru' ? 'Сначала активные' : 'Recently Active'}</option>
                  <option value="last_seen-asc">{lang === 'ru' ? 'Сначала неактивные' : 'Least Recently Active'}</option>
                  <option value="nickname-asc">{lang === 'ru' ? 'Имя (A-Z)' : 'Name (A-Z)'}</option>
                  <option value="nickname-desc">{lang === 'ru' ? 'Имя (Z-A)' : 'Name (Z-A)'}</option>
                  {/* Role is alphabetical by the label shown on the badge, so the
                      options are named A-Z / Z-A. They used to read "Ранг"
                      (Rank), which described the old permission-weight order. */}
                  <option value="role_id-asc">{lang === 'ru' ? 'Роль (А-Я)' : 'Role (A-Z)'}</option>
                  <option value="role_id-desc">{lang === 'ru' ? 'Роль (Я-А)' : 'Role (Z-A)'}</option>
                  <option value="post_count-desc">{lang === 'ru' ? 'Больше постов' : 'Most Posts'}</option>
                  <option value="post_count-asc">{lang === 'ru' ? 'Меньше постов' : 'Fewest Posts'}</option>
                  <option value="reputation-desc">{lang === 'ru' ? 'Выше репутация' : 'Highest Rep'}</option>
                  <option value="reputation-asc">{lang === 'ru' ? 'Ниже репутация' : 'Lowest Rep'}</option>
                  <option value="created_at-desc">{lang === 'ru' ? 'Сначала новые' : 'Newest First'}</option>
                  <option value="created_at-asc">{lang === 'ru' ? 'Сначала старые' : 'Oldest First'}</option>
                </Form.Select>
              </div>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title={lang === 'ru' ? 'Обновить список' : 'Refresh list'}
                aria-label={lang === 'ru' ? 'Обновить список участников' : 'Refresh members list'}
                className="d-inline-flex align-items-center gap-2"
              >
                <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} />
                <span className="d-none d-xl-inline">
                  {lang === 'ru' ? 'Обновить' : 'Refresh'}
                </span>
              </Button>
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
