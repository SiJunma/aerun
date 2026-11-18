import React from 'react';
import { ArrowRightLeft } from 'lucide-react';
import ForumModal from '../common/ForumModal';
import Timestamp from '../common/Timestamp';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * AuditDetailsModal renders structured details for an audit log entry
 * according to SPEC_REFACTOR_AUDIT_LOGS.md §3.
 */
export default function AuditDetailsModal({
  show,
  onHide,
  log,
  users = [],
  categories = [],
  currentLang = 'ru',
  isRootAdmin = false,
  auditActionLabel = (act) => act,
}) {
  const { t } = useI18n();

  if (!log) return null;

  const details = log.details || {};
  const actionType = log.action_type || log.actionType || '';

  // Helpers to resolve entities safely
  const resolveUserName = (userId) => {
    if (!userId) return null;
    if (userId === log.performer_id && log.performerNickname) {
      return log.performerNickname;
    }
    const user = users.find((u) => u.id === userId);
    if (user) {
      return user.nickname || (isRootAdmin ? user.email : '***');
    }
    if (log.targetNickname) {
      return log.targetNickname;
    }
    return null;
  };

  const resolveCategoryTitle = (catId) => {
    if (!catId) return null;
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return null;
    if (typeof cat.name === 'object' && cat.name !== null) {
      return cat.name[currentLang] || cat.name.ru || cat.name.en;
    }
    if (typeof cat.title === 'object' && cat.title !== null) {
      return cat.title[currentLang] || cat.title.ru || cat.title.en;
    }
    return cat.name || cat.title || null;
  };

  const renderUserPair = (userId, label, defaultNick) => {
    if (!userId) return null;
    const resolved = defaultNick || resolveUserName(userId);
    return (
      <div className="mb-2">
        <span className="fw-bold">{label}:</span>{' '}
        {resolved ? (
          <span>
            <strong>{resolved}</strong>{' '}
            <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>
              ({userId})
            </span>
          </span>
        ) : (
          <span>
            <span className="text-muted fst-italic">
              {t('admin.audit.details.deleted_account')}
            </span>{' '}
            <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>
              ({userId})
            </span>
          </span>
        )}
      </div>
    );
  };

  const renderChangesDiff = (changes) => {
    if (!changes || typeof changes !== 'object') return null;
    const entries = Object.entries(changes);
    if (entries.length === 0) return null;

    return (
      <div className="d-flex flex-column gap-2 mt-2">
        <div className="fw-bold text-muted text-uppercase" style={{ fontSize: '0.7rem' }}>
          {t('admin.audit.details.changes')}
        </div>
        {entries.map(([key, diff]) => {
          const transK = t(`admin.audit.fields.${key}`);
          const fieldLabel = transK === `admin.audit.fields.${key}` ? key : transK;
          const fromVal = diff && typeof diff.from === 'object' && diff.from !== null
            ? JSON.stringify(diff.from)
            : String(diff?.from ?? '');
          const toVal = diff && typeof diff.to === 'object' && diff.to !== null
            ? JSON.stringify(diff.to)
            : String(diff?.to ?? '');

          return (
            <div
              key={key}
              className="p-2 rounded border border-secondary border-opacity-10"
              style={{ backgroundColor: 'var(--input-bg)', color: 'var(--text-color)' }}
            >
              <div className="fw-bold small mb-1">{fieldLabel}:</div>
              <div className="d-flex align-items-center gap-2 small flex-wrap">
                <span className="text-danger text-decoration-line-through opacity-75">
                  {fromVal || <em className="text-muted">{t('admin.audit.details.empty_value') || 'empty'}</em>}
                </span>
                <ArrowRightLeft size={10} className="text-muted" />
                <span className="text-success fw-bold">
                  {toVal || <em className="text-muted">{t('admin.audit.details.empty_value') || 'empty'}</em>}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Structured rendering by action type
  const renderStructuredContent = () => {
    // 1. Post Delete (§3.1)
    if (actionType === 'post_delete') {
      const isGuest = details.author_kind === 'guest' || (!details.author_id && details.guest_display_name);
      const catTitle = details.category_title || resolveCategoryTitle(details.category_id);

      return (
        <div className="d-flex flex-column gap-2">
          {/* Author */}
          {isGuest ? (
            <div className="mb-2">
              <span className="fw-bold">{t('admin.audit.details.author')}:</span>{' '}
              <span>
                {details.guest_display_name || t('admin.audit.details.guest_author')}{' '}
                <span className="badge bg-secondary ms-1">
                  {t('admin.audit.details.guest_author')}
                </span>
              </span>
            </div>
          ) : (
            renderUserPair(details.author_id, t('admin.audit.details.author'))
          )}

          {/* Created at */}
          {details.created && (
            <div className="mb-2">
              <span className="fw-bold">{t('admin.audit.details.date')}:</span>{' '}
              <Timestamp date={details.created} />
            </div>
          )}

          {/* Topic */}
          {(details.topic_title || details.topic_id) && (
            <div className="mb-2">
              <span className="fw-bold">{t('admin.audit.details.topic')}:</span>{' '}
              <strong>{details.topic_title || details.topic_id}</strong>
              {details.topic_id && details.topic_title && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.topic_id})
                </span>
              )}
            </div>
          )}

          {/* Category */}
          {(catTitle || details.category_id) && (
            <div className="mb-2">
              <span className="fw-bold">{t('admin.audit.details.category')}:</span>{' '}
              <strong>{catTitle || details.category_id}</strong>
              {details.category_id && catTitle && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.category_id})
                </span>
              )}
            </div>
          )}

          {/* Deletion context */}
          <div className="mb-2">
            <span className="fw-bold">{t('admin.audit.details.deleted_by')}:</span>{' '}
            <span className="badge bg-info text-dark">
              {details.by_author
                ? t('admin.audit.details.by_author')
                : t('admin.audit.details.by_moderator')}
            </span>
          </div>

          {/* Post Content */}
          {details.content && (
            <div className="mt-2">
              <div className="fw-bold mb-1">{t('admin.audit.details.post_content')}:</div>
              <div
                className="p-3 rounded border border-secondary border-opacity-25"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-color)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '250px',
                  overflowY: 'auto',
                }}
              >
                {details.content}
              </div>
            </div>
          )}
        </div>
      );
    }

    // 2. Character Masks (§3.2)
    if (actionType === 'character_updated' || actionType === 'character_avatar_changed' || actionType === 'character_created' || actionType === 'character_deleted') {
      return (
        <div className="d-flex flex-column gap-2">
          {details.name && (
            <div className="mb-2">
              <span className="fw-bold">{t('admin.audit.details.mask')}:</span>{' '}
              <strong>{details.name}</strong>
              {details.target_id && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.target_id})
                </span>
              )}
            </div>
          )}
          {renderUserPair(details.owner_id, t('admin.audit.details.owner'))}

          {actionType === 'character_avatar_changed' && (
            <div className="alert alert-success py-2 px-3 mb-2 small">
              ✓ {t('admin.audit.details.avatar_updated')}
            </div>
          )}

          {details.changes && renderChangesDiff(details.changes)}
        </div>
      );
    }

    // 3. User & Identity Management
    if (
      actionType.startsWith('admin_user_') ||
      actionType.startsWith('user_') ||
      actionType === 'user banned' ||
      actionType === 'user unbanned' ||
      actionType === 'user registered' ||
      actionType === 'nickname_change' ||
      actionType === 'profile_edit' ||
      actionType === 'password_change' ||
      actionType === 'email_change' ||
      actionType === 'provider_unlink' ||
      actionType === 'root_transfer'
    ) {
      const targetUserId = details.target_id || details.user_id || details.id;
      return (
        <div className="d-flex flex-column gap-2">
          {targetUserId && renderUserPair(targetUserId, t('admin.audit.fields.targetId') || 'User')}

          {details.nickname && (
            <div className="mb-1">
              <span className="fw-bold">{t('admin.audit.fields.nickname')}:</span>{' '}
              <strong>{details.nickname}</strong>
            </div>
          )}

          {details.role && (
            <div className="mb-1">
              <span className="fw-bold">{t('admin.audit.fields.roleId')}:</span>{' '}
              <span className="badge bg-secondary">{details.role}</span>
            </div>
          )}

          {actionType === 'root_transfer' && details.from && details.to && (
            <div className="p-2 rounded border border-secondary border-opacity-10 bg-opacity-10 mb-2">
              <div>
                <strong>From:</strong> {resolveUserName(details.from) || details.from} ({details.from})
              </div>
              <div>
                <strong>To:</strong> {resolveUserName(details.to) || details.to} ({details.to})
              </div>
            </div>
          )}

          {details.changes && renderChangesDiff(details.changes)}
        </div>
      );
    }

    // 4. Topics & Content Management
    if (actionType.startsWith('topic_') || actionType === 'post_edit' || actionType === 'dm_message_delete' || actionType.startsWith('reputation_')) {
      const catTitle = details.category_title || resolveCategoryTitle(details.category_id);
      return (
        <div className="d-flex flex-column gap-2">
          {(details.topic_title || details.title) && (
            <div className="mb-1">
              <span className="fw-bold">{t('admin.audit.details.topic')}:</span>{' '}
              <strong>{details.topic_title || details.title}</strong>
              {details.topic_id && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.topic_id})
                </span>
              )}
            </div>
          )}

          {(catTitle || details.category_id) && (
            <div className="mb-1">
              <span className="fw-bold">{t('admin.audit.details.category')}:</span>{' '}
              <strong>{catTitle || details.category_id}</strong>
              {details.category_id && catTitle && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.category_id})
                </span>
              )}
            </div>
          )}

          {details.author_id && renderUserPair(details.author_id, t('admin.audit.details.author'))}
          {details.target_id && renderUserPair(details.target_id, t('admin.audit.fields.targetId') || 'Target')}

          {details.content && (
            <div className="mt-2">
              <div className="fw-bold mb-1">{t('admin.audit.details.post_content')}:</div>
              <div
                className="p-3 rounded border border-secondary border-opacity-25"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-color)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflowY: 'auto',
                }}
              >
                {details.content}
              </div>
            </div>
          )}

          {details.changes && renderChangesDiff(details.changes)}
        </div>
      );
    }

    // 5. Structure & Settings (Roles, Categories, Groups, Designs, Settings)
    if (
      actionType.startsWith('role_') ||
      actionType.startsWith('category_') ||
      actionType.startsWith('design_') ||
      actionType.startsWith('settings_') ||
      actionType.startsWith('email_template_')
    ) {
      const title = typeof details.name === 'object' && details.name !== null
        ? details.name[currentLang] || details.name.ru || details.name.en
        : typeof details.title === 'object' && details.title !== null
          ? details.title[currentLang] || details.title.ru || details.title.en
          : details.name || details.title;

      return (
        <div className="d-flex flex-column gap-2">
          {title && (
            <div className="mb-1">
              <span className="fw-bold">{t('admin.audit.fields.name') || 'Name'}:</span>{' '}
              <strong>{title}</strong>
              {details.target_id && (
                <span className="text-muted font-monospace ms-1" style={{ fontSize: '0.75rem' }}>
                  ({details.target_id})
                </span>
              )}
            </div>
          )}

          {details.changes && renderChangesDiff(details.changes)}
        </div>
      );
    }

    // 6. Generic Fallback for unknown / future action types
    // TODO: add tailored template for new action_type
    console.warn(`[AuditDetailsModal] Fallback rendering used for action_type: ${actionType}`);

    const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (entries.length === 0) {
      return <div className="text-muted fst-italic">—</div>;
    }

    return (
      <div className="d-flex flex-column gap-2">
        {entries.map(([k, v]) => {
          if (k === 'changes' && typeof v === 'object') {
            return <div key={k}>{renderChangesDiff(v)}</div>;
          }

          const transK = t(`admin.audit.fields.${k}`);
          const label = transK === `admin.audit.fields.${k}` ? k : transK;

          // If ID, try to resolve to nickname or title
          let resolvedLabel = null;
          if (typeof v === 'string' && (k.toLowerCase().includes('id') || k.toLowerCase().includes('user'))) {
            resolvedLabel = resolveUserName(v) || resolveCategoryTitle(v);
          }

          return (
            <div key={k} className="mb-1">
              <span className="fw-bold">{label}:</span>{' '}
              {resolvedLabel ? (
                <span>
                  <strong>{resolvedLabel}</strong>{' '}
                  <span className="text-muted font-monospace" style={{ fontSize: '0.75rem' }}>
                    ({v})
                  </span>
                </span>
              ) : typeof v === 'object' ? (
                <pre className="mt-1 p-2 rounded small" style={{ backgroundColor: 'var(--input-bg)' }}>
                  {JSON.stringify(v, null, 2)}
                </pre>
              ) : (
                <span>{String(v)}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const performerDisplay = log.performerNickname || resolveUserName(log.performer_id) || 'Unknown User';

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={t('admin.audit.table_details')}
      bodyClassName="small"
    >
      <div className="d-flex flex-column gap-3" style={{ wordBreak: 'break-word' }}>
        {/* Unified Header */}
        <div
          className="p-3 rounded border border-secondary border-opacity-25"
          style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-color)' }}
        >
          <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
            <div>
              <span className="audit-badge">{auditActionLabel(log.action_type)}</span>
            </div>
            <div className="text-muted small">
              {log.created_at ? <Timestamp date={log.created_at} /> : '...'}
            </div>
          </div>
          <div>
            <div
              className="fw-bold text-muted text-uppercase mb-1"
              style={{ fontSize: '0.7rem' }}
            >
              {t('admin.audit.details.performer')}
            </div>
            <div className="fw-bold">{performerDisplay}</div>
            <div
              className="text-muted font-monospace"
              style={{ fontSize: '0.75rem' }}
            >
              ID: {log.performer_id}
            </div>
          </div>
        </div>

        {/* Structured Body */}
        <div
          className="p-3 rounded border border-secondary border-opacity-25"
          style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-color)' }}
        >
          {renderStructuredContent()}
        </div>

        {/* Footer info: Log ID */}
        <div
          style={{
            color: 'var(--secondary-color)',
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            textAlign: 'right',
          }}
        >
          {t('admin.audit.details.log_id') || 'Log ID'}: {log.id}
        </div>
      </div>
    </ForumModal>
  );
}

