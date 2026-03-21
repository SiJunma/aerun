import React from 'react';
import { useParams } from 'react-router-dom';
import { Container } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import DirectMessages from '../components/dm/DirectMessages';

/**
 * MessagesPage
 * Route /messages         → inbox (own conversations)
 * Route /messages/:uid    → open chat with that user
 */
const MessagesPage = () => {
  const { uid: targetUid } = useParams();
  const { profile } = useAuth();

  if (!profile) return null;

  return (
    <Container className="p-0 p-lg-4">
      <DirectMessages
        mode={targetUid ? 'chat' : 'inbox'}
        targetUid={targetUid || null}
      />
    </Container>
  );
};

export default MessagesPage;
