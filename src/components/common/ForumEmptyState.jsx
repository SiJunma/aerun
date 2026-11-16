import React from 'react';
import { Card } from 'react-bootstrap';

/**
 * Shared "nothing here yet" panel.
 *
 * NotificationsPage was the only page that styled its empty state (glass card,
 * line icon, title, supporting line); every other page fell back to a bare
 * muted sentence, which read as broken text rather than an intentional state.
 * One component means every list announces itself the same way.
 *
 * @param {React.ComponentType} icon  lucide-react icon rendered at strokeWidth 1
 * @param {string} title              the state itself ("No topics yet")
 * @param {string} description        why it is empty / what happens next
 * @param {React.ReactNode} action    optional call to action
 * @param {string} className
 */
const ForumEmptyState = ({ icon: Icon, title, description, action, className = '' }) => (
  <Card className={`empty-state-card ${className}`.trim()}>
    <Card.Body>
      {Icon && (
        <div className="mb-4 empty-state-icon">
          <Icon size={60} strokeWidth={1} />
        </div>
      )}
      {title && <h4 className="empty-state-title mb-2">{title}</h4>}
      {description && <p className="empty-state-desc mb-0 small">{description}</p>}
      {action && <div className="mt-4 d-flex justify-content-center">{action}</div>}
    </Card.Body>
  </Card>
);

export default ForumEmptyState;