import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Container, Table, Form, InputGroup, Image, Badge, Row, Col, Card, Button } from 'react-bootstrap';
import { Search, ArrowUpDown, User, Calendar, MessageSquare, Award, Clock, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { fetchMembers, toMembersRow, withLegacyDates } from '../api/auth-resources';
import { subscribeToRtdbStatuses } from '../api/rtdb-presence';
import { resolveAvatarUrl } from '../api/avatars';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import ForumPagination from '../components/common/ForumPagination';
import Timestamp from '../components/common/Timestamp';
import { toMillis as sharedToMillis } from '../utils/dates';
import ErrorCard from '../components/common/ErrorCard';
import Skeleton from '../components/common/Skeleton';

// The legacy pseudo-role labels are no longer used for sorting: the server
// orders by the stored role id, since the rendered label lives in the roles
// registry, which the public route must not join.
const LEGACY_PSEUDO_ROLE_LABELS = {
  banned: 'Banned',
  pending: 'Pending',
  deleted: 'Deleted'
};
void LEGACY_PSEUDO_ROLE_LABELS;

// Server-side ordering keys — the allow-list GET /api/aerun/users accepts.
// The role key orders by the stored role id: the rendered label lives in the
// roles registry, which the public route must not join.
const MEMBER_SORT_OPTIONS = {
  nickname: (dir) => ({ sort: 'nickname', order: dir }),
  role: (dir) => ({ sort: 'role', order: dir }),
  last_seen: (dir) => ({ sort: 'last_seen', order: dir }),
  post_count: (dir) => ({ sort: 'post_count', order: dir }),
  reputation: (dir) => ({ sort: 'reputation', order: dir }),
  created_at: (dir) => ({ sort: 'created_at', order: dir }),
};

import { usePageTitle } from '../contexts/TitleProvider';
import { useToast } from '../contexts/ToastProvider';

const MembersPage = () => {
  const { t } = useI18n();
  const { profile, updateSettings, settings } = useAuth();
  const { setPageTitle } = usePageTitle();
  const { showToast } = useToast();
  const [users, setUsers] = useState([]);
  const [rtdbStatuses, setRtdbStatuses] = useState({});
  // The board is server-paginated: the server narrows (search) and orders
  // (sort/order) BEFORE the page is cut, and answers with the envelope
  // {items, totalItems, totalPages}. One request renders one page — this page
  // no longer asks for every page at once just to render the whole board.
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('last_seen');
  const [sortOrder, setSortOrder] = useState('desc');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Bumped by the refresh button; the loader effect re-reads the current page.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // RES-03: load-failure state. The old catch zeroed the board, so a
  // network failure and an actually-empty board were the same render.
  const [membersError, setMembersError] = useState(null);
  const [membersLoading, setMembersLoading] = useState(true);
  const sortKey = MEMBER_SORT_OPTIONS[sortField] ? `${sortField}-${sortOrder}` : 'last_seen-desc';
  const sortParams = useMemo(() => {
    const option = MEMBER_SORT_OPTIONS[sortField] || MEMBER_SORT_OPTIONS.last_seen;
    return option(sortOrder);
  }, [sortField, sortOrder]);

  const handleRefresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    // The toast confirms the ACTION, not the outcome. The board is
    // server-paginated and the walk is bounded by the server's own
    // totalPages, so there is no single number here that means "how
    // current is this" — reporting a count would imply a certainty the
    // page does not have.
    //
    // The load is fire-and-forget, so the spinner is released on a short
    // timer: a spinner that never stops is worse than one that ends a
    // moment early.
    setRefreshNonce(n => n + 1);
    setTimeout(() => {
      setIsRefreshing(false);
      showToast(t('forum.members_refreshed'), 'success');
    }, 600);
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

  // The search field holds the LIVE input; the COMMITTED value only changes
  // 400 ms after the last keystroke, so typing "anna" costs one server read,
  // not four, and every commit returns the board to page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // One request renders one page. `fetchMembers` narrows and orders on the
  // server, so the envelope's totals are the NARROWED set's.
  useEffect(() => {
    let alive = true;
    setMembersLoading(true);
    fetchMembers({ page, search, sort: sortParams.sort, order: sortParams.order })
      .then(res => {
        if (!alive) return;
        setMembersError(null);
        const items = (res?.items || []).map(u => withLegacyDates(toMembersRow(u)));
        const tp = Math.max(1, res?.totalPages ?? 1);
        setUsers(items);
        setTotalItems(res?.totalItems ?? 0);
        setTotalPages(tp);
        // A page that emptied out under us — rows deleted on the last page,
        // a search that narrowed — steps back to the last real one instead
        // of showing an empty table forever.
        if (items.length === 0 && page > tp) setPage(tp);
      })
      .catch((err) => {
        if (alive) {
          // RES-03: save the error instead of zeroing the board. The
          // old catch set users/totalItems/totalPages to empty values,
          // so a network failure rendered exactly like "0 participants"
          // — the silent half of the bug. The ErrorCard branch below
          // carries the error and the retry nonce instead.
          setMembersError(err);
          console.error('[MembersPage] fetchMembers failed:', err);
        }
      })
      .finally(() => {
        if (alive) setMembersLoading(false);
      });
    return () => { alive = false; };
  }, [page, search, sortParams, refreshNonce]);

  useEffect(() => {
    const unsubStatuses = subscribeToRtdbStatuses(setRtdbStatuses);
    return () => {
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

  // The rows are already filtered and ordered by the server: `users` holds
  // exactly one page of the narrowed, ordered set. No client-side sort or
  // filter remains — it was the reason this page fetched the whole board.
  const tableUsers = users;

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // Default to desc for count/date fields, asc for text.
      if (['post_count', 'reputation', 'created_at', 'last_seen'].includes(field)) {
        setSortOrder('desc');
      } else {
        setSortOrder('asc');
      }
    }
    setPage(1);
  };

  const getRoleBadge = (u) => (
    <ForumRoleBadge
      roleId={u.role}
      userEmail={u.email}
    />
  );

  // RES-03: a load failure renders the error card, not an empty table.
  // The old catch zeroed users/totalItems/totalPages, so "no members"
  // and "the request failed" were the same render. The guard keeps the
  // card off a board that already has rows from an earlier page — a
  // pagination error during search must not blank the table the member
  // is already reading; only a first-load failure is the card's job.
  if (membersError && !membersLoading && users.length === 0) {
    return (
      <Container className="py-4">
        <ErrorCard
          title={t('forum.failed_load_members')}
          error={membersError}
          onRetry={() => {
            setMembersError(null);
            setRefreshNonce((n) => n + 1);
          }}
        />
      </Container>
    );
  }

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
            {totalItems}
          </Badge>
        </h2>
        <p className="text-muted">
          {t('forum.members_title')}
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
                  placeholder={t('forum.search_placeholder')}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
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
                <span className="text-muted small me-1">{t('forum.sort_by')}</span>
                <Form.Select
                  size="sm"
                  className="d-inline-block w-auto shadow-sm"
                  value={sortKey}
                  onChange={(e) => {
                    const [field, order] = e.target.value.split('-');
                    setSortField(field);
                    setSortOrder(order);
                    setPage(1);
                  }}
                >
                  {/* Activity first: it is the default order, so the control opens
                      on the option that is actually in effect. */}
                  <option value="last_seen-desc">{t('forum.sort_recently_active')}</option>
                  <option value="last_seen-asc">{t('forum.sort_least_active')}</option>
                  <option value="nickname-asc">{t('forum.sort_name_az')}</option>
                  <option value="nickname-desc">{t('forum.sort_name_za')}</option>
                  {/* Role is alphabetical by the label shown on the badge, so the
                      options are named A-Z / Z-A. They used to read "Ранг"
                      (Rank), which described the old permission-weight order. */}
                  <option value="role-asc">{t('forum.sort_role_az')}</option>
                  <option value="role-desc">{t('forum.sort_role_za')}</option>
                  <option value="post_count-desc">{t('forum.sort_most_posts')}</option>
                  <option value="post_count-asc">{t('forum.sort_fewest_posts')}</option>
                  <option value="reputation-desc">{t('forum.sort_highest_rep')}</option>
                  <option value="reputation-asc">{t('forum.sort_lowest_rep')}</option>
                  <option value="created_at-desc">{t('forum.sort_newest')}</option>
                  <option value="created_at-asc">{t('forum.sort_oldest')}</option>
                </Form.Select>
              </div>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title={t('forum.refresh_members')}
                aria-label={t('forum.refresh_members')}
                className="d-inline-flex align-items-center gap-2"
              >
                <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} />
                <span className="d-none d-xl-inline">
                  {t('forum.refresh_members')}
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
                  {t('forum.member')}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('role')}>
                  {t('forum.role')}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '15%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('created_at')}>
                  {t('forum.joined')}
                  <ArrowUpDown size={12} />
                </div>
              </th>
              <th className="py-3" style={{ width: '20%', border: 'none' }}>
                <div className="d-flex align-items-center gap-1 cursor-pointer user-select-none" onClick={() => handleSort('last_seen')}>
                  {t('forum.last_seen')}
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
            {membersLoading && users.length === 0 ? (
              <tr>
                <td colSpan="6" className="py-5 border-0">
                  <Skeleton width="100%" height="14rem" className="mb-2" />
                </td>
              </tr>
            ) : tableUsers.length > 0 ? (
              tableUsers.map(u => (
                <tr key={u.id} className="align-middle members-table-row">
                  <td className="ps-4 py-3 border-0" data-label={t('forum.member')}>
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
                  <td className="border-0" data-label={t('forum.role')}>{getRoleBadge(u)}</td>
                  <td className="small text-muted border-0" data-label={t('forum.joined')}>
                    <div className="d-flex align-items-center gap-1">
                      <Calendar size={14} className="flex-shrink-0" />
                      {formatDate(u.created_at || u.registered_at || u.joined_at)}
                    </div>
                  </td>
                  <td className="small text-muted border-0" data-label={t('forum.last_seen')}>
                    <div className="d-flex align-items-center gap-1">
                      <Clock size={14} className="flex-shrink-0" />
                      {formatLastSeen(getUserLastSeen(u))}
                    </div>
                  </td>
                  <td className="text-center fw-semibold text-primary border-0" data-label={t('forum.posts')}>{u.post_count || 0}</td>
                  {settings?.enableReputation && (
                    <td className="text-center pe-4 border-0" data-label={t('forum.rep')}>
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
                  {t('forum.no_members')}
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
      {/* Server-side pagination: the footer mirrors the response envelope —
          one request renders one page, and `totalItems` is the count of the
          NARROWED set (the search filter applies before the page is cut).
          ForumPagination hides itself when there is a single page. */}
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-3">
        <span className="text-muted small">{t('forum.members_total', { count: totalItems })}</span>
        <ForumPagination
          currentPage={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </div>
    </Container>
  );
};

export default MembersPage;
