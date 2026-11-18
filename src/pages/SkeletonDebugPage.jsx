import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthProvider';
import TopicPostCard from '../components/topic/TopicPostCard';
import TopicRow from '../components/common/TopicRow';
import Skeleton from '../components/common/Skeleton';

/**
 * /_debug/skeletons — дебаг-страница скелетонов (только root-админ / dev).
 *
 * Рендерит все скелетоны через живые компоненты в режиме `skeleton`, без
 * запросов к API (данные не подгружаются). Контролы на лету: количество
 * постов/строк, число строк текста в посте, тема, пресет viewport.
 * Роут не в навигации и не индексируется.
 */
const VIEWPORTS = [
  { label: 'Мобилка 390px', width: 390 },
  { label: 'Планшет 768px', width: 768 },
  { label: 'Десктоп 1280px', width: 1280 },
];

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

const inlineSkeletonLines = (count, width = '100%') =>
  Array.from({ length: count }, (_, i) => (
    <div key={i} style={{ marginBottom: '0.5rem' }}>
      <Skeleton width={width} height="1rem" />
    </div>
  ));

export const SkeletonDebugPage = () => {
  const { profile } = useAuth();
  const isRoot = profile?.role === 'root';

  const [postsCount, setPostsCount] = useState(3);
  const [rowsCount, setRowsCount] = useState(5);
  const [linesCount, setLinesCount] = useState(5);
  const [viewport, setViewport] = useState(VIEWPORTS[2]);
  const [viewTheme, setViewTheme] = useState(() =>
    document.body.dataset.theme || 'dark'
  );

  // Тема превью применяется напрямую к data-theme — без запросов к API.
  useEffect(() => {
    document.body.dataset.theme = viewTheme;
  }, [viewTheme]);

  const vp = VIEWPORTS.find((v) => v.width === viewport.width) || VIEWPORTS[2];
  const screenW =
    typeof window !== 'undefined' ? window.innerWidth : 1280;
  const scale = Math.min(1, (screenW - 40) / vp.width);
  const previewStyle = {
    width: vp.width + 'px',
    margin: '0 auto',
    transform: `scale(${scale})`,
    transformOrigin: 'top center',
  };

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
                background: viewTheme === t.value ? 'var(--primary-color)' : 'transparent',
                color: viewTheme === t.value ? '#fff' : 'inherit',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <label
            style={{
              fontSize: '0.85rem',
              opacity: 0.8,
              marginBottom: '0.25rem',
            }}
          >
            Viewport
          </label>
          {VIEWPORTS.map((v) => (
            <button
              key={v.width}
              onClick={() => setViewport(v)}
              style={{
                padding: '0.15rem 0.6rem',
                fontSize: '0.8rem',
                border: '1px solid var(--border-color)',
                background: viewport.width === v.width ? 'var(--primary-color)' : 'transparent',
                color: viewport.width === v.width ? '#fff' : 'inherit',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {section(
          'Пост темы — скелетон',
          'TopicPostCard.jsx (components/topic)',
          (
            <div style={previewStyle}>
              {Array.from({ length: postsCount }, (_, i) => (
                <div key={i} style={{ marginBottom: '1rem' }}>
                  <TopicPostCard skeleton skeletonLines={linesCount} />
                </div>
              ))}
            </div>
          )
        )}

        {section(
          'Строка топика — скелетон',
          'TopicRow.jsx (components/common)',
          (
            <div style={previewStyle}>
              {Array.from({ length: rowsCount }, (_, i) => (
                <div key={i} style={{ marginBottom: '0.75rem' }}>
                  <TopicRow skeleton showCategoryInColumn />
                </div>
              ))}
            </div>
          )
        )}

        {section(
          'Шапка категории — скелетон',
          'CategoryPage.jsx (pages) — инлайн',
          <div style={previewStyle}>{inlineSkeletonLines(3)}</div>
        )}

        {section(
          'Шапка профиля — скелетон',
          'ProfilePage.jsx (pages) — инлайн',
          (
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'flex-start',
              }}
            >
              <div
                style={{
                  width: '72px',
                  height: '72px',
                  borderRadius: '50%',
                  background: 'var(--border-color)',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {inlineSkeletonLines(1, '60%')}
                {inlineSkeletonLines(2, '40%')}
              </div>
            </div>
          )
        )}

        {section(
          'Участники — строка скелетона',
          'MembersPage.jsx (pages) — инлайн',
          (
            <div style={previewStyle}>
              {Array.from({ length: rowsCount }, (_, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.5rem 0',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                >
                  <div
                    style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      background: 'var(--border-color)',
                    }}
                  />
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.3rem',
                      flex: 1,
                    }}
                  >
                    {inlineSkeletonLines(1, '30%')}
                    {inlineSkeletonLines(1, '20%')}
                  </div>
                  <div
                    style={{
                      width: '70px',
                      textAlign: 'right',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.3rem',
                    }}
                  >
                    {inlineSkeletonLines(1, '100%')}
                    {inlineSkeletonLines(1, '60%')}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        <p
          style={{
            marginTop: '1.5rem',
            fontSize: '0.85rem',
            opacity: 0.7,
          }}
        >
          Примечание: строки категории, профиля и участников показаны инлайн-полосками.
          По мере перевода этих компонентов на живые скелетон-ветки (см. план §F-05)
          замените их на скелетон-ветку живого компонента, как TopicPostCard/TopicRow.
        </p>
      </div>
    </div>
  );
};

export default SkeletonDebugPage;
