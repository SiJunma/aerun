import React from 'react';
import { Card, Row, Col } from 'react-bootstrap';
import Skeleton from '../common/Skeleton';

/**
 * ProfileSkeleton — скелетон-ветка страницы профиля.
 *
 * Рендерит ту же оболочку и классы, что и живой профиль (Bootstrap Card →
 * profile-sidebar-wrapper → профиль-сайдбар + табы), контент заменён полосками.
 * Нет id, без data-хуков, без живых ссылок/кнопок.
 *
 * Две секции: шапка профиля (header) и вкладка About (about).
 */
const ProfileSkeleton = ({ section = 'header' }) => {
  if (section === 'header') {
    return (
      <Card className="shadow-sm border-0 bg-card">
        <Card.Header className="py-3">
          <h5 className="mb-0">
            <Skeleton width="40%" height="1rem" />
          </h5>
        </Card.Header>
        <Card.Body className="p-3">
          <div className="profile-sidebar-wrapper d-flex flex-row align-items-start gap-3 d-lg-block text-lg-center">
            <div className="flex-shrink-0 text-center profile-sidebar-avatar">
              <Skeleton
                variant="avatar"
                width={72}
                height={72}
                className="rounded-circle d-block mx-auto shadow-sm"
                style={{ border: '3px solid var(--border-color)' }}
              />
            </div>
            <div className="flex-grow-1 min-w-0 w-100 profile-sidebar-info">
              <div className="mb-2 mb-lg-3 text-lg-center">
                <Skeleton width="140px" height="1.5rem" className="d-block mb-1 mx-lg-auto" />
                <Skeleton width="100px" height="0.85rem" className="d-block mx-lg-auto" />
              </div>
              <div className="profile-sidebar-stats d-flex justify-content-start justify-content-lg-between gap-4 gap-lg-0 align-items-center border-top pt-2 mt-1">
                <div className="profile-stat-item text-start">
                  <span className="text-muted d-block small mb-0" style={{ fontSize: '0.72rem' }}>
                    <Skeleton width="45%" height="0.72rem" />
                  </span>
                  <div className="fw-bold">
                    <Skeleton width="45px" height="1.2rem" />
                  </div>
                </div>
                <div className="profile-stat-item text-start text-lg-end">
                  <span className="text-muted d-block small mb-0" style={{ fontSize: '0.72rem' }}>
                    <Skeleton width="45%" height="0.72rem" />
                  </span>
                  <div className="profile-rep-row d-flex align-items-center justify-content-start justify-content-lg-end gap-1">
                    <div className="fw-bold text-accent">
                      <Skeleton width="45px" height="1.2rem" />
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-2 text-start text-lg-center profile-sidebar-role">
                <span className="text-muted d-block mb-1 fw-bold text-uppercase" style={{ fontSize: '0.62rem', letterSpacing: '0.1em' }}>
                  <Skeleton width="55%" height="0.62rem" />
                </span>
                <Skeleton width="100px" height="1.4rem" className="mx-lg-auto" />
              </div>
            </div>
          </div>
        </Card.Body>
      </Card>
    );
  }

  // section === 'about'
  return (
    <Card className="shadow-sm border-0 bg-card">
      <Card.Header className="py-3">
        <h5 className="mb-0">
          <Skeleton width="30%" height="1rem" />
        </h5>
      </Card.Header>
      <Card.Body className="p-4">
        <div className="mb-4 pb-4 border-bottom">
          <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
            <Skeleton width={16} height={16} />
            <Skeleton width="20%" height="0.75rem" />
          </h6>
          <div className="post-content fs-5" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
            <span style={{ visibility: 'hidden' }}>{' '.repeat(120)}</span>
            <Skeleton width="100%" height="1.25rem" />
            <Skeleton width="80%" height="1.25rem" />
            <Skeleton width="60%" height="1.25rem" />
          </div>
        </div>
        <div className="mb-4 pb-4 border-bottom">
          <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
            <Skeleton width={16} height={16} />
            <Skeleton width="20%" height="0.75rem" />
          </h6>
          <Row className="g-4">
            <Col md={6}>
              <div className="d-flex align-items-start gap-2">
                <Skeleton width={18} height={18} className="mt-1 flex-shrink-0 text-primary opacity-75" />
                <div>
                  <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>
                    <Skeleton width="30%" height="0.7rem" />
                  </span>
                  <div className="fs-6">
                    <Skeleton width="60%" height="1rem" />
                  </div>
                </div>
              </div>
            </Col>
            <Col md={6}>
              <div className="d-flex align-items-start gap-2">
                <Skeleton width={18} height={18} className="mt-1 flex-shrink-0 text-danger opacity-75" />
                <div>
                  <span className="text-muted d-block small text-uppercase fw-bold" style={{ fontSize: '0.7rem' }}>
                    <Skeleton width="30%" height="0.7rem" />
                  </span>
                  <div className="fs-6">
                    <Skeleton width="40%" height="1rem" />
                  </div>
                </div>
              </div>
            </Col>
          </Row>
        </div>
        <div className="pt-2">
          <h6 className="text-primary text-uppercase small fw-bold mb-3 d-flex align-items-center gap-2">
            <Skeleton width={16} height={16} />
            <Skeleton width="20%" height="0.75rem" />
          </h6>
          <div className="text-muted" style={{ whiteSpace: 'pre-wrap' }}>
            <span style={{ visibility: 'hidden' }}>{' '.repeat(80)}</span>
            <Skeleton width="100%" height="1.25rem" />
            <Skeleton width="70%" height="1.25rem" />
          </div>
        </div>
      </Card.Body>
    </Card>
  );
};

export default ProfileSkeleton;