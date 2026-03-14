import React from 'react';
import { Breadcrumb } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Reusable Breadcrumbs component for Aerun Forum.
 * @param {Array} items - Array of breadcrumb items: { label, to, active }
 */
const ForumBreadcrumbs = ({ items = [] }) => {
  const { t } = useI18n();

  return (
    <Breadcrumb className="mb-4">
      <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/' }}>
        {t('nav.home')}
      </Breadcrumb.Item>
      {items.map((item, index) => (
        <Breadcrumb.Item
          key={index}
          linkAs={item.active ? undefined : Link}
          linkProps={item.active ? undefined : { to: item.to }}
          active={item.active}
        >
          {item.label}
        </Breadcrumb.Item>
      ))}
    </Breadcrumb>
  );
};

export default ForumBreadcrumbs;
