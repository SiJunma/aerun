import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Offcanvas } from 'react-bootstrap';
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
import { useI18n } from '../../contexts/I18nProvider';
import './AdminSidebar.css';

/**
 * Admin navigation — the sidebar of the admin panel.
 *
 * WHAT THIS COMPONENT OWNS
 *
 *   1. The collapsible groups of sections it is handed. The groups arrive
 *      already filtered by the viewer's permissions (see
 *      `src/config/adminNavigation.js`), so a section the viewer may not open
 *      is never rendered, and a group that ends up empty is never rendered
 *      either.
 *   2. The open/closed state of those groups.
 *   3. The mobile drawer.
 *
 * WHY THE NAVIGATION IS RENDERED ONCE
 *
 * A desktop sidebar and a mobile drawer are usually two copies of the same
 * markup, which means two sets of `data-tab` hooks for a theme to trip over
 * and two focusable copies of every link. Here the whole navigation is ONE
 * Bootstrap `Offcanvas` with the `responsive` prop: from `lg` up Bootstrap
 * renders it as a static, always-visible block, and below that as a drawer
 * that slides in from the edge. Exactly one copy of the markup exists at any
 * moment, and the drawer brings the focus handling, the Escape key, the
 * backdrop and the scroll lock with it.
 *
 * The DOM contract for themes (ids, classes, state classes and data
 * attributes) follows `markdowns/TODO_THEMEABLE_SPRINT_PLAN.md`:
 * `#admin-sidebar`, `.admin-sidebar`, `.admin-sidebar-group`,
 * `.admin-sidebar-group-header`, `.admin-nav-link`, `.is-active`,
 * `.is-collapsed`, `data-group`, `data-tab`.
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
const NavIcon = ({ name, size = 17, className = '' }) => {
  const Icon = ICON_MAP[name];
  if (!Icon) return null;
  return <Icon size={size} className={className} aria-hidden="true" />;
};

const AdminSidebar = ({ groups, activeTab, onSelect }) => {
  const { t } = useI18n();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // Groups the viewer has folded away, keyed by group id.
  const [collapsedGroups, setCollapsedGroups] = useState({});

  const activeGroupId = useMemo(
    () => groups.find((group) => group.children.some((item) => item.path === activeTab))?.id || null,
    [groups, activeTab]
  );

  // The group holding the open section must be expanded, or the section the
  // viewer is looking at has no visible entry in the navigation. This is
  // adjusted while rendering (the same "adjust state when a value changes"
  // pattern the theme provider uses) rather than in an effect, so the
  // navigation is never painted with the wrong group folded.
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

  const openDrawer = useCallback(() => setIsDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), []);

  const handleSelect = useCallback(
    (path) => {
      onSelect(path);
      // On a phone the navigation covers the page, so it must get out of the
      // way once the viewer has chosen where to go.
      setIsDrawerOpen(false);
    },
    [onSelect]
  );

  // Widening the window past the breakpoint turns the drawer back into an
  // inline column. The `show` flag has to be dropped along with it, or the
  // drawer would reappear the moment the window narrows again.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 992px)');
    const onChange = (event) => {
      if (event.matches) setIsDrawerOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);



  const renderGroups = () =>
    groups.map((group) => {
      const isCollapsed = !!collapsedGroups[group.id];
      return (
        <div
          key={group.id}
          className={`admin-sidebar-group ${isCollapsed ? 'is-collapsed' : 'is-open'}`}
          data-group={group.id}
        >
          <button
            type="button"
            className="admin-sidebar-group-header"
            aria-expanded={!isCollapsed}
            aria-controls={`admin-group-${group.id}`}
            onClick={() => toggleGroup(group.id)}
          >
            <span className="admin-sidebar-group-title">
              <NavIcon name={group.icon} size={15} className="admin-sidebar-group-icon" />
              <span>{t(group.title)}</span>
            </span>
            <ChevronDown size={15} className="admin-sidebar-group-chevron" />
          </button>

          <ul id={`admin-group-${group.id}`} className="admin-sidebar-list">
            {group.children.map((item) => {
              const isActive = item.path === activeTab;
              return (
                <li key={item.id} className="admin-nav-item">
                  <button
                    type="button"
                    className={`admin-nav-link ${isActive ? 'is-active' : ''}`}
                    data-tab={item.path}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => handleSelect(item.path)}
                  >
                    <NavIcon name={item.icon} className="admin-nav-link-icon" />
                    <span className="admin-nav-link-text">{t(item.title)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      );
    });

  return (
    <>
      <Button
        variant="outline-secondary"
        size="sm"
        className="admin-nav-toggle d-lg-none"
        aria-expanded={isDrawerOpen}
        aria-controls="admin-sidebar"
        onClick={openDrawer}
      >
        <Menu size={16} className="admin-nav-toggle-icon" />
        <span>{t('admin.nav.toggleMenu')}</span>
      </Button>

      <Offcanvas
        responsive="lg"
        placement="start"
        show={isDrawerOpen}
        onHide={closeDrawer}
        className="admin-sidebar"
        aria-labelledby="admin-sidebar-title"
      >
        <Offcanvas.Header closeButton className="admin-sidebar-header">
          <Offcanvas.Title id="admin-sidebar-title" className="admin-sidebar-title">
            {t('admin.nav.menuLabel')}
          </Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body className="admin-sidebar-body">
          <nav id="admin-sidebar" className="admin-nav" aria-label={t('admin.nav.menuLabel')}>
            {renderGroups()}
          </nav>
        </Offcanvas.Body>
      </Offcanvas>
    </>
  );
};

export default AdminSidebar;
