import React, { useState, useMemo } from 'react';
import { Offcanvas, OverlayTrigger, Tooltip } from 'react-bootstrap';
import {
  Menu,
  ChevronDown,
  Users,
  User,
  Shield,
  Layers,
  FolderTree,
  Palette,
  Settings,
  Sliders,
  FileText
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { getFilteredNavGroups } from '../../navigation/adminNavigationConfig';
import './AdminSidebar.css';

const ICON_MAP = {
  Users,
  User,
  Shield,
  Layers,
  FolderTree,
  Palette,
  Settings,
  Sliders,
  FileText
};

const NavItemIcon = ({ name, size = 18 }) => {
  const IconComponent = ICON_MAP[name] || Settings;
  return <IconComponent size={size} />;
};

const AdminSidebar = ({
  activeTab,
  onSelectTab,
  collapsed = false,
  onToggleCollapse,
  mobileOpen = false,
  onCloseMobile
}) => {
  const { hasPermission } = useAuth();
  const { t } = useI18n();

  // All groups open by default in accordion
  const [openGroups, setOpenGroups] = useState({
    userAndAccess: true,
    forumContent: true,
    system: true
  });

  const toggleGroup = (groupId) => {
    setOpenGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId]
    }));
  };

  const visibleGroups = useMemo(() => {
    return getFilteredNavGroups(hasPermission);
  }, [hasPermission]);

  const handleItemClick = (tabId) => {
    if (onSelectTab) {
      onSelectTab(tabId);
    }
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const renderNavList = (isCollapsedMode = false) => (
    <div className="admin-sidebar__nav">
      {visibleGroups.map((group) => {
        const isOpen = openGroups[group.id] !== false;
        const groupTitle = t(group.title);

        return (
          <div key={group.id} className="admin-sidebar__group">
            {!isCollapsedMode && (
              <div
                className="admin-sidebar__group-header"
                onClick={() => toggleGroup(group.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    toggleGroup(group.id);
                  }
                }}
              >
                <span>{groupTitle}</span>
                <ChevronDown
                  size={14}
                  className={`admin-sidebar__group-chevron ${
                    isOpen ? '' : 'admin-sidebar__group-chevron--collapsed'
                  }`}
                />
              </div>
            )}

            {(isCollapsedMode || isOpen) && (
              <div className="admin-sidebar__group-items">
                {group.children.map((item) => {
                  const isActive = activeTab === item.id;
                  const itemTitle = t(item.title);

                  const buttonNode = (
                    <button
                      key={item.id}
                      type="button"
                      className={`admin-nav-item ${
                        isActive ? 'admin-nav-item--active' : ''
                      }`}
                      onClick={() => handleItemClick(item.id)}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className="admin-nav-item__icon">
                        <NavItemIcon name={item.icon} size={18} />
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
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`admin-sidebar d-none d-lg-flex ${
          collapsed ? 'admin-sidebar--collapsed' : 'admin-sidebar--expanded'
        }`}
      >
        <div className="admin-sidebar__header">
          <button
            type="button"
            className="admin-sidebar__toggle-btn"
            onClick={onToggleCollapse}
            title={collapsed ? t('common.expand') || 'Expand' : t('common.collapse') || 'Collapse'}
            aria-label="Toggle sidebar"
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
        className="admin-offcanvas d-lg-none"
        placement="start"
      >
        <Offcanvas.Header closeButton>
          <Offcanvas.Title className="fw-bold fs-5">
            {t('admin.dashboard')}
          </Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body className="p-0">
          {renderNavList(false)}
        </Offcanvas.Body>
      </Offcanvas>
    </>
  );
};

export default AdminSidebar;

