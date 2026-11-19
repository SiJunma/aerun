import React from 'react';
import Skeleton from './Skeleton';

/**
 * MembersRowSkeleton — скелетон-ветка строки участника (MembersPage).
 *
 * Рендерит ту же оболочку и классы, что и живая строка таблицы участников
 * (<tr className="members-table-row"> с аватаром 40px), контент заменён
 * полосками. Нет id, без data-хуков, без живых ссылок.
 */
const MembersRowSkeleton = () => (
  <tr key="members-skeleton" className="align-middle members-table-row">
    <td className="ps-4 py-3 border-0" data-label="member">
      <div className="d-flex align-items-center gap-3">
        <div
          className="rounded-circle"
          style={{ width: '40px', height: '40px', background: 'var(--border-color)' }}
        />
        <div className="text-truncate">
          <div className="fw-bold text-truncate member-nickname">
            <Skeleton width="60%" height="1rem" />
          </div>
          <Skeleton width="40%" height="0.8rem" className="text-muted d-block text-truncate" />
        </div>
      </div>
    </td>
    <td className="border-0" data-label="role">
      <Skeleton width="80px" height="1.2rem" />
    </td>
    <td className="small text-muted border-0" data-label="joined">
      <div className="d-flex align-items-center gap-1">
        <Skeleton width={14} height={14} className="flex-shrink-0" />
        <Skeleton width="60%" height="1rem" />
      </div>
    </td>
    <td className="small text-muted border-0" data-label="last_seen">
      <div className="d-flex align-items-center gap-1">
        <Skeleton width={14} height={14} className="flex-shrink-0" />
        <Skeleton width="50%" height="1rem" />
      </div>
    </td>
    <td className="text-center fw-semibold text-primary border-0" data-label="posts">
      <Skeleton width="40px" height="1rem" />
    </td>
    <td className="text-center pe-4 border-0" data-label="rep">
      <Skeleton width="40px" height="1rem" />
    </td>
  </tr>
);

export default MembersRowSkeleton;
