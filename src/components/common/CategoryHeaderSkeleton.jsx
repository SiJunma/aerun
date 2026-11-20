import React from 'react';
import Skeleton from './Skeleton';

/**
 * CategoryHeaderSkeleton — скелетон-ветка шапки категории.
 *
 * Рендерит ту же оболочку, что и живая шапка категории (заголовок, описание,
 * кнопки действий), контент заменён полосками. Нет id, без data-хуков,
 * без живых ссылок/кнопок.
 */
const CategoryHeaderSkeleton = () => (
  <header id="forum-view-header" className="category-header">
    <div className="category-header-heading">
      <h1 className="category-header-title">
        <Skeleton width={150} height="1.5rem" />
      </h1>
      <Skeleton width={250} height="1rem" className="category-header-skeleton" />
    </div>
    <div className="category-header-actions">
      <Skeleton width={120} height="2.5rem" />
    </div>
  </header>
);

export default CategoryHeaderSkeleton;
