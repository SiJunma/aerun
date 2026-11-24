import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../contexts/I18nProvider';

export default function TopTopicsTable({ topics = [] }) {
  const { t } = useI18n();

  if (!topics || topics.length === 0) {
    return (
      <div className="visits-empty-state">
        {t('admin.visits.table.no_topics', 'No topic visits recorded for this period.')}
      </div>
    );
  }

  return (
    <div className="visits-table-scroll">
      <table className="visits-table">
        <thead>
          <tr>
            <th>{t('admin.visits.table.topic', 'Topic')}</th>
            <th>{t('admin.visits.table.readers', 'Unique Readers')}</th>
            <th>{t('admin.visits.table.views', 'Views')}</th>
            <th>{t('admin.visits.table.last_visit', 'Last Visit')}</th>
          </tr>
        </thead>
        <tbody>
          {topics.map((top) => (
            <tr key={top.topic_id}>
              <td>
                <Link to={`/topic/${top.topic_id}`} className="visits-topic-link">
                  {top.title || `#${top.topic_id}`}
                </Link>
              </td>
              <td>
                <strong>{(top.unique_readers || 0).toLocaleString()}</strong>
              </td>
              <td>{(top.views || 0).toLocaleString()}</td>
              <td className="visits-text-muted">
                {top.last_visited ? new Date(top.last_visited).toLocaleString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
