import React, { useState, useEffect } from 'react';
import { Table } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import { useI18n } from '../contexts/I18nProvider';
import TopicPostCard from '../components/topic/TopicPostCard';
import TopicRow from '../components/common/TopicRow';
import MembersRowSkeleton from '../components/common/MembersRowSkeleton';
import CategoryHeaderSkeleton from '../components/common/CategoryHeaderSkeleton';
import ProfileSkeleton from '../components/profile/ProfileSkeleton';

/**
 * /_debug/skeletons — дебаг-страница скелетонов (только root-админ / dev).
 *
 * Рендерит все скелетоны через живые компоненты в режиме `skeleton`, без
 * запросов к API (данные не подгружаются). Контролы на лету: количество
 * постов/строк, число строк текста в посте, тема. Роут не в навигации и
 * не индексируется.
 *
 * Пресетов viewport здесь НЕТ — специально: медиазапросы считаются от
 * реального окна браузера, а не от ширины дива, поэтому фиксированная
 * ширина + scale показывали десктопную раскладку под видом мобильной
 * (а 1280px вообще не влезали в контейнер). Скелетоны идут во всю ширину
 * страницы: мобильную версию смотрят ресайзом окна или device-режимом
 * DevTools. Секции, у которых в живом приложении узкая колонка
 * (шапка профиля — сайдбар, About — контентная колонка), ограничены
 * той же шириной, что и в живом приложении.
 */
const THEMES = [
  { value: 'dark', label: 'Тёмная' },
  { value: 'light', label: 'Светлая' },
  { value: 'neutral', label: 'Нейтральная' },
];

const section = (title, source, children) => (
  <section
    className="sk-debug-section"
    style={{
      marginBottom: '2rem',
      border: '1px solid var(--border-color)',
      borderRadius: '0.5rem',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        padding: '0.75rem 1rem',
        background: 'var(--bg-color)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      <strong style={{ fontSize: '0.9rem' }}>{title}</strong>
      <span style={{ fontSize: '0.75rem', opacity: 0.7, fontFamily: 'monospace' }}>
        {source}
      </span>
    </div>
    <div style={{ padding: '1rem' }}>{children}</div>
  </section>
);

export const SkeletonDebugPage = () => {
  const { profile, settings } = useAuth();
  const { t } = useI18n();
  const isRoot = profile?.role === 'root';

  const [postsCount, setPostsCount] = useState(3);
  const [rowsCount, setRowsCount] = useState(5);
  const [linesCount, setLinesCount] = useState(3);
  const [viewTheme, setViewTheme] = useState(() =>
    document.body.dataset.theme || 'dark'
  );

  // Тема превью применяется напрямую к data-theme — без запросов к API.
  useEffect(() => {
    document.body.dataset.theme = viewTheme;
  }, [viewTheme]);

  if (!isRoot) {
    return null;
  }

  return (
    <div
      style={{
        padding: '1rem',
        maxWidth: '1200px',
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
        color: 'var(--text-color)',
      }}
    >
      <h1 style={{ marginBottom: '1rem' }}>Скелетоны — отладка</h1>
      <p style={{ opacity: 0.7, marginBottom: '1.5rem' }}>
        Живые компоненты в режиме `skeleton`. Без запросов к API, без id/якорей,
        без живых ссылок и кнопок. Роут только для админа, не в навигации.
        Мобильную версию — ресайзом окна или device-режимом DevTools.
      </p>

      {/* Controls */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'center',
          marginBottom: '2rem',
          padding: '1rem',
          background: 'var(--bg-color)',
          border: '1px solid var(--border-color)',
          borderRadius: '0.5rem',
        }}
      >
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.85rem',
              opacity: 0.8,
              marginBottom: '0.25rem',
            }}
          >
            Постов в скелетоне темы
          </label>
          <input
            type="range"
            min="1"
            max="8"
            value={postsCount}
            onChange={(e) => setPostsCount(Number(e.target.value))}
            style={{ width: '180px' }}
          />
          <span style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            {postsCount}
          </span>
        </div>
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.85rem',
              opacity: 0.8,
              marginBottom: '0.25rem',
            }}
          >
            Строк топиков
          </label>
          <input
            type="range"
            min="1"
            max="12"
            value={rowsCount}
            onChange={(e) => setRowsCount(Number(e.target.value))}
            style={{ width: '180px' }}
          />
          <span style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            {rowsCount}
          </span>
        </div>
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.85rem',
              opacity: 0.8,
              marginBottom: '0.25rem',
            }}
          >
            Строк текста в посте
          </label>
          <input
            type="range"
            min="1"
            max="10"
            value={linesCount}
            onChange={(e) => setLinesCount(Number(e.target.value))}
            style={{ width: '180px' }}
          />
          <span style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>
            {linesCount}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <label
            style={{
              fontSize: '0.85rem',
              opacity: 0.8,
              marginBottom: '0.25rem',
            }}
          >
            Тема превью
          </label>
          {THEMES.map((t) => (
            <button
              key={t.value}
              onClick={() => setViewTheme(t.value)}
              style={{
                padding: '0.15rem 0.6rem',
                fontSize: '0.8rem',
                border: '1px solid var(--border-color)',
                background:
                  viewTheme === t.value ? 'var(--primary-color)' : 'transparent',
                color: viewTheme === t.value ? '#fff' : 'inherit',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {section(
          'Пост темы — скелетон',
          'TopicPostCard.jsx (components/topic)',
          (
            <>
              {Array.from({ length: postsCount }, (_, i) => (
                <div key={i} style={{ marginBottom: '1rem' }}>
                  <TopicPostCard skeleton skeletonLines={linesCount} />
                </div>
              ))}
            </>
          )
        )}

        {section(
          'Строка топика — скелетон',
          'TopicRow.jsx (components/common)',
          (
            <>
              {Array.from({ length: rowsCount }, (_, i) => (
                <div key={i} style={{ marginBottom: '0.75rem' }}>
                  <TopicRow skeleton showCategoryInColumn />
                </div>
              ))}
            </>
          )
        )}

        {section(
          'Шапка категории — скелетон',
          'CategoryHeaderSkeleton.jsx (components/common)',
          <CategoryHeaderSkeleton />
        )}

        {section(
          'Шапка профиля — скелетон',
          'ProfileSkeleton.jsx (components/profile)',
          (
            // Живая шапка — узкая колонка-сайдбар (Col lg={3}), а не вся
            // ширина страницы: иначе все полоски в % разъезжаются.
            <div style={{ maxWidth: '340px' }}>
              <ProfileSkeleton section="header" />
            </div>
          )
        )}

        {section(
          'Участники — строка скелетона',
          'MembersRowSkeleton.jsx (components/common)',
          (
            // Строки участников — это <tr>: без настоящей таблицы колонки
            // не выстраиваются. Та же оболочка, что на MembersPage.
            <div className="table-responsive rounded shadow-sm members-table-container">
              <Table className="align-middle mb-0 border-0">
                <thead className="small text-muted text-uppercase fw-bold members-table-head">
                  <tr>
                    <th className="py-3 ps-4" style={{ width: '30%', border: 'none' }}>
                      {t('forum.member')}
                    </th>
                    <th className="py-3" style={{ width: '15%', border: 'none' }}>
                      {t('forum.role')}
                    </th>
                    <th className="py-3" style={{ width: '15%', border: 'none' }}>
                      {t('forum.joined')}
                    </th>
                    <th className="py-3" style={{ width: '20%', border: 'none' }}>
                      {t('forum.last_seen')}
                    </th>
                    <th className="py-3 text-center" style={{ width: '10%', border: 'none' }}>
                      {t('forum.posts')}
                    </th>
                    {settings?.enableReputation && (
                      <th className="py-3 text-center pe-4" style={{ width: '10%', border: 'none' }}>
                        {t('forum.rep')}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="border-0">
                  {Array.from({ length: rowsCount }, (_, i) => (
                    <MembersRowSkeleton key={i} showRep={settings?.enableReputation} />
                  ))}
                </tbody>
              </Table>
            </div>
          )
        )}

        {section(
          'Вкладка About профиля — скелетон',
          'ProfileSkeleton.jsx (components/profile, section="about")',
          (
            // Живой About — контентная колонка (Col lg={9}).
            <div style={{ maxWidth: '860px' }}>
              <ProfileSkeleton section="about" />
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default SkeletonDebugPage;
