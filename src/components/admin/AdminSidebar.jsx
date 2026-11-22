import React, { useCallback, useMemo, useState } from 'react';
import { Offcanvas, OverlayTrigger, Tooltip } from 'react-bootstrap';
import {
  Users,
  User,
  Shield,
  Layers,
  FolderTree,
  Palette,
  Settings,
  Sliders,
  FileText,
  ChevronDown,
  Menu,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import {
  ADMIN_NAV_GROUPS,
  filterNavByPermissions,
  findGroupForTab,
} from '../../config/adminNavigation';
import './AdminSidebar.css';

/**
 * Admin navigation — the collapsible responsive sidebar of the admin panel.
 *
 * DOM contract for custom themes follows markdowns/TODO_THEMEABLE_SPRINT_PLAN.md:
 * - `#admin-sidebar`
 * - `.admin-sidebar`, `.admin-sidebar--collapsed`, `.admin-sidebar--expanded`
 * - `.admin-sidebar__header`, `.admin-sidebar__title`, `.admin-sidebar__toggle-btn`
 * - `.admin-sidebar__nav`, `.admin-sidebar__group`, `.admin-sidebar__group-header`
 * - `.admin-sidebar__group-chevron`, `.admin-sidebar__group-items`
 * - `.admin-nav-item`, `.admin-nav-item--active`, `.admin-nav-item__icon`, `.admin-nav-item__label`
 * - `.admin-offcanvas`, `.admin-offcanvas__header`, `.admin-offcanvas__title`, `.admin-offcanvas__body`
 * - `data-group`, `data-tab`, `.is-active`, `.is-collapsed`
 */

/** Icon components the navigation config may name. */
const ICON_MAP = {
  Users,
  User,
  Shield,
  Layers,
  FolderTree,
  Palette,
  Settings,
  Sliders,
  FileText,
  ChevronDown,
  Menu,
};

/** Renders the icon named by the navigation config, if it is a known one. */
const NavIcon = ({ name, size = 18, className = '' }) => {
  const Icon = ICON_MAP[name];
  if (!Icon) return null;
  return <Icon size={size} className={className} aria-hidden="true" />;
};

const AdminSidebar = ({
  groups,
  activeTab,
  onSelectTab,
  onSelect,
  collapsed = false,
  onToggleCollapse,
  mobileOpen = false,
  onCloseMobile,
}) => {
  const { hasPermission } = useAuth();
  const { t } = useI18n();

  // Navigation tree filtered by the viewer's permissions
  const navGroups = useMemo(() => {
    if (groups && groups.length > 0) return groups;
    return filterNavByPermissions(ADMIN_NAV_GROUPS, hasPermission);
  }, [groups, hasPermission]);

  // Groups the viewer has folded away, keyed by group id
  const [collapsedGroups, setCollapsedGroups] = useState({});

  const activeGroupId = useMemo(
    () => findGroupForTab(navGroups, activeTab),
    [navGroups, activeTab]
  );

  // The group holding the open section must be expanded automatically
  const [prevActiveGroupId, setPrevActiveGroupId] = useState(activeGroupId);
  if (activeGroupId !== prevActiveGroupId) {
    setPrevActiveGroupId(activeGroupId);
    if (activeGroupId) {
      setCollapsedGroups((prev) =>
        prev[activeGroupId] ? { ...prev, [activeGroupId]: false } : prev
      );
    }
  }

  const toggleGroup = useCallback((groupId) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const handleItemClick = useCallback(
    (tabId) => {
      if (onSelectTab) onSelectTab(tabId);
      if (onSelect) onSelect(tabId);
      if (onCloseMobile) onCloseMobile();
    },
    [onSelectTab, onSelect, onCloseMobile]
  );

  const renderNavList = (isCollapsedMode = false) => (
    <nav className="admin-sidebar__nav" aria-label={t('admin.nav.menuLabel')}>
      {navGroups.map((group) => {
        const isCollapsed = !isCollapsedMode && !!collapsedGroups[group.id];
        const groupTitle = t(group.title);

        return (
          <div
            key={group.id}
            className={`admin-sidebar__group ${isCollapsed ? 'is-collapsed' : 'is-open'}`}
            data-group={group.id}
          >
            {!isCollapsedMode && (
              <button
                type="button"
                className="admin-sidebar__group-header"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={!isCollapsed}
                aria-controls={`admin-group-${group.id}`}
              >
                <span className="admin-sidebar__group-title">
                  <NavIcon name={group.icon} size={15} className="admin-sidebar__group-icon" />
                  <span>{groupTitle}</span>
                </span>
                <ChevronDown
                  size={14}
                  className={`admin-sidebar__group-chevron ${
                    isCollapsed ? 'admin-sidebar__group-chevron--collapsed' : ''
                  }`}
                />
              </button>
            )}

            {(!isCollapsed || isCollapsedMode) && (
              <div id={`admin-group-${group.id}`} className="admin-sidebar__group-items">
                {group.children.map((item) => {
                  const isActive = activeTab === item.path || activeTab === item.id;
                  const itemTitle = t(item.title);

                  const buttonNode = (
                    <button
                      key={item.id}
                      type="button"
                      className={`admin-nav-item ${
                        isActive ? 'admin-nav-item--active is-active' : ''
                      }`}
                      data-tab={item.path}
                      onClick={() => handleItemClick(item.path)}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className="admin-nav-item__icon">
                        <NavIcon name={item.icon} size={18} />
                      </span>
                      {!isCollapsedMode && (
                        <span className="admin-nav-item__label">{itemTitle}</span>
                      )}
                    </button>
                  );

                  if (isCollapsedMode) {
                    return (
                      <OverlayTrigger
                        key={item.id}
                        placement="right"
                        overlay={<Tooltip id={`tooltip-${item.id}`}>{itemTitle}</Tooltip>}
                      >
                        {buttonNode}
                      </OverlayTrigger>
                    );
                  }

                  return buttonNode;
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        id="admin-sidebar"
        className={`admin-sidebar ${
          collapsed ? 'admin-sidebar--collapsed' : 'admin-sidebar--expanded'
        }`}
      >
        <div className="admin-sidebar__header">
          <button
            type="button"
            className="admin-sidebar__toggle-btn"
            onClick={onToggleCollapse}
            title={collapsed ? t('common.expand') || 'Expand' : t('common.collapse') || 'Collapse'}
            aria-label={collapsed ? t('common.expand') || 'Expand' : t('common.collapse') || 'Collapse'}
          >
            <Menu size={20} />
          </button>
          {!collapsed && (
            <h2 className="admin-sidebar__title">{t('admin.dashboard')}</h2>
          )}
        </div>

        {renderNavList(collapsed)}
      </aside>

      {/* Mobile Drawer (Offcanvas) */}
      <Offcanvas
        show={mobileOpen}
        onHide={onCloseMobile}
        className="admin-offcanvas"
        placement="start"
        aria-labelledby="admin-offcanvas-title"
      >
        <Offcanvas.Header closeButton className="admin-offcanvas__header">
          <Offcanvas.Title id="admin-offcanvas-title" className="admin-offcanvas__title">
            {t('admin.dashboard')}
          </Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body className="admin-offcanvas__body">
          {renderNavList(false)}
        </Offcanvas.Body>
      </Offcanvas>
    </>
  );
};

export default AdminSidebar;
