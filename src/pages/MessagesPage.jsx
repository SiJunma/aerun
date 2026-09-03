import React from 'react';
import { useParams } from 'react-router-dom';
import { Container } from 'react-bootstrap';
import { useAuth } from '../contexts/AuthProvider';
import DirectMessages from '../components/dm/DirectMessages';
import ErrorCard from '../components/common/ErrorCard';

import { usePageTitle } from '../contexts/TitleProvider';
import { useI18n } from '../contexts/I18nProvider';

/**
 * MessagesPage
 * Route /messages         → inbox (own conversations)
 * Route /messages/:uid    → open chat with that user
 */
const MessagesPage = () => {
  const { uid: targetUid } = useParams();
  const { profile } = useAuth();
  const { setPageTitle } = usePageTitle();
  const { t, lang } = useI18n();

  const [timeoutExpired, setTimeoutExpired] = React.useState(false);

  React.useEffect(() => {
    setPageTitle(t('messages.title', 'Сообщения'));
  }, [setPageTitle, t, lang]);

  React.useEffect(() => {
    if (!profile) {
      const timer = setTimeout(() => {
        setTimeoutExpired(true);
      }, 6000);
      return () => clearTimeout(timer);
    } else {
      setTimeoutExpired(false);
    }
  }, [profile]);

  if (!profile) {
    if (timeoutExpired) {
      return (
        <Container className="py-4">
          <ErrorCard
            isNetworkError={true}
            title={lang === 'ru' ? 'Не удалось загрузить профиль для сообщений' : 'Failed to load profile for messages'}
            message={lang === 'ru'
              ? 'Сервер не ответил вовремя. Пожалуйста, проверьте подключение к интернету или попробуйте обновить страницу.'
              : 'The server did not respond in time. Please check your internet connection or try refreshing the page.'
            }
            onRetry={() => window.location.reload()}
          />
        </Container>
      );
    }

    return (
      <Container className="p-5 text-center text-muted">
        <div className="spinner-border text-primary mb-3" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
        <p>{lang === 'ru' ? 'Подключение к сообщениям...' : 'Connecting to messages...'}</p>
      </Container>
    );
  }

  return (
    <div className="messages-page-wrapper">
      <DirectMessages
        mode={targetUid ? 'chat' : 'inbox'}
        targetUid={targetUid || null}
      />
    </div>
  );
};

export default MessagesPage;
