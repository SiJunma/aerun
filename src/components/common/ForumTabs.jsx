import React from 'react';

/**
 * Shared page-level tab strip.
 *
 * The pages that used to hand-roll `nav nav-tabs` rendered their labels
 * straight onto the forum background photo, so an injected custom design that
 * styles `.nav-link` for the dark navbar left them unreadable. This component
 * owns the markup, and index.css owns the contrast-critical colours:
 *   - the strip carries its own translucent surface (`.forum-tabs-wrap`);
 *   - label colours are pinned with !important so no design can override them;
 *   - the selected tab is a filled chip, not just an underline.
 *
 * @param {Array<{id: string, label: string, icon?: React.ReactNode, badge?: number}>} tabs
 * @param {string} activeId
 * @param {(id: string) => void} onChange
 * @param {string} className
 */
const ForumTabs = ({ tabs = [], activeId, onChange, className = '' }) => {
  if (tabs.length === 0) return null;

  return (
    <div className={`forum-tabs-wrap mb-3 ${className}`.trim()}>
      <ul className="nav nav-tabs forum-tabs" role="tablist">
        {tabs.map(tab => {
          const isActive = tab.id === activeId;
          return (
            <li className="nav-item" key={tab.id}>
              <button
                type="button"
                role="tab"
                id={`forum-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`forum-tabpanel-${tab.id}`}
                className={`nav-link${isActive ? ' active' : ''}`}
                onClick={() => onChange(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge > 0 && (
                  <span className="forum-tab-badge">{tab.badge}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default ForumTabs;