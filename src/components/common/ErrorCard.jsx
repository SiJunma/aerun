import React, { useState } from 'react';
import { Card, Button, Collapse } from 'react-bootstrap';
import { AlertTriangle, WifiOff, RefreshCw, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * ErrorCard — Human-friendly, informative error and connection-failure component.
 * Displays a clear description of the issue, actionable advice (e.g. VPN hints),
 * and an expandable technical details section with a one-click copy button for admins.
 */

// classify works out WHY a request failed from what sendApi throws.
//
// This used to be a hardcoded `isNetworkError` at every call site, which meant a
// 500 from the server was announced as "Unable to connect to the server. Please
// check your internet connection" — sending the reader to reboot their router
// because a handler crashed. A wrong diagnosis costs more than no diagnosis:
// it hides a server fault from exactly the person who could report it.
//
// sendApi puts status 0 on a genuine transport failure and the real HTTP status
// on everything else, so the answer is already in the error.
const classifyError = (error) => {
  const status = Number(error?.status ?? 0);
  if (status === 0 || error?.code === 'network_error') return 'network';
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  return 'generic';
};

const COPY = {
  network: {
    title: ['Ошибка соединения с сервером', 'Server Connection Error'],
    message: [
      'Не удалось установить соединение с сервером. Пожалуйста, проверьте подключение к интернету или попробуйте обновить страницу.',
      'Unable to connect to the server. Please check your internet connection or try refreshing the page.'
    ]
  },
  server: {
    title: ['Сервер не смог выполнить запрос', 'The Server Could Not Complete This Request'],
    message: [
      'Сервер ответил ошибкой. Это проблема на стороне сервера, а не ваше подключение — повторная попытка может помочь. Если ошибка повторяется, сообщите администратору: номер запроса указан в технических деталях.',
      'The server returned an error. This is a server-side problem, not your connection — retrying may help. If it keeps happening, tell an administrator; the request id is in the technical details.'
    ]
  },
  auth: {
    title: ['Нет доступа', 'Access Denied'],
    message: [
      'Сервер не дал доступ к этим данным. Возможно, у вас нет прав или сессия истекла.',
      'The server refused access to this data. You may lack permission, or the session has expired.'
    ]
  },
  generic: {
    title: ['Не удалось загрузить данные', 'Failed to Load Data'],
    message: [
      'Произошла непредвиденная ошибка при получении данных. Попробуйте обновить страницу или повторить попытку.',
      'An unexpected error occurred while fetching data. Please try refreshing or retrying.'
    ]
  }
};

const ErrorCard = ({
  title,
  message,
  error,
  onRetry,
  // `undefined` means "work it out from the error". Passing true/false pins the
  // kind, which is right only when the caller genuinely knows better than the
  // status code (a client-side timeout, for instance).
  isNetworkError,
  className = 'my-4'
}) => {
  const { lang } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const errorString = error
    ? (typeof error === 'object' ? (error.stack || error.message || JSON.stringify(error)) : String(error))
    : '';

  const kind = typeof isNetworkError === 'boolean'
    ? (isNetworkError ? 'network' : 'generic')
    : classifyError(error);
  const copy = COPY[kind];
  const pick = (pair) => (lang === 'ru' ? pair[0] : pair[1]);

  const defaultTitle = pick(copy.title);
  const defaultMessage = pick(copy.message);
  const isNetwork = kind === 'network';

  const handleCopy = () => {
    const report = [
      `=== AERUN ERROR REPORT ===`,
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `Title: ${title || defaultTitle}`,
      `Error: ${errorString}`,
      // The status and request id are what let an administrator find the
      // matching server-side log line, so the report carries them rather than
      // making the reader reconstruct them from the prose.
      `Status: ${error?.status ?? 'n/a'}`,
      `Error code: ${error?.code ?? 'n/a'}`,
      `Request ID: ${error?.requestId ?? 'n/a'}`,
      `User Agent: ${navigator.userAgent}`
    ].join('\n');

    navigator.clipboard.writeText(report).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  };

  return (
    <Card className={`border-0 shadow-sm ${className}`} style={{ background: 'var(--card-bg)', overflow: 'hidden' }}>
      <div style={{ height: '4px', background: 'var(--bs-danger, #dc3545)' }} />
      <Card.Body className="p-4 text-center">
        <div className="mb-3 d-inline-flex p-3 rounded-circle" style={{ background: 'rgba(220, 53, 69, 0.1)', color: 'var(--bs-danger, #dc3545)' }}>
          {isNetwork ? <WifiOff size={36} /> : <AlertTriangle size={36} />}
        </div>

        <h5 className="fw-bold mb-2">{title || defaultTitle}</h5>
        <p className="text-muted mb-4 mx-auto" style={{ maxWidth: '600px', fontSize: '0.95rem', lineHeight: '1.5' }}>
          {message || defaultMessage}
        </p>

        <div className="d-flex flex-wrap justify-content-center gap-2 mb-3">
          {onRetry && (
            <Button variant="primary" onClick={onRetry} className="d-flex align-items-center gap-2 px-3">
              <RefreshCw size={16} />
              {lang === 'ru' ? 'Повторить попытку' : 'Retry'}
            </Button>
          )}
          <Button
            variant="outline-secondary"
            onClick={() => window.location.reload()}
            className="d-flex align-items-center gap-2 px-3"
          >
            {lang === 'ru' ? 'Перезагрузить страницу' : 'Reload Page'}
          </Button>
          {errorString && (
            <Button
              variant="outline-danger"
              size="sm"
              onClick={() => setShowDetails(!showDetails)}
              className="d-flex align-items-center gap-1"
            >
              {lang === 'ru' ? 'Технические детали' : 'Technical Details'}
              {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </Button>
          )}
        </div>

        {errorString && (
          <Collapse in={showDetails}>
            <div className="mt-3 text-start mx-auto" style={{ maxWidth: '700px' }}>
              <div className="p-3 rounded" style={{ background: 'var(--block-bg, rgba(0,0,0,0.1))', border: '1px solid var(--border-color)', fontSize: '0.8rem', fontFamily: 'monospace' }}>
                <div className="d-flex justify-content-between align-items-center mb-2 pb-1 border-bottom">
                  <span className="text-muted fw-bold">
                    {lang === 'ru' ? 'Отчёт об ошибке для администратора:' : 'Error report for administrator:'}
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={handleCopy}
                    className="p-0 text-decoration-none d-flex align-items-center gap-1"
                  >
                    {copied ? (
                      <>
                        <Check size={14} className="text-success" />
                        <span className="text-success">{lang === 'ru' ? 'Скопировано' : 'Copied'}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={14} />
                        <span>{lang === 'ru' ? 'Скопировать' : 'Copy'}</span>
                      </>
                    )}
                  </Button>
                </div>
                <div className="text-danger mb-1 fw-bold">{error?.message || errorString.split('\n')[0]}</div>
                <div className="text-muted" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '150px', overflowY: 'auto' }}>
                  {errorString}
                </div>
              </div>
            </div>
          </Collapse>
        )}
      </Card.Body>
    </Card>
  );
};

export default ErrorCard;
