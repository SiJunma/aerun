import React, { useState } from 'react';
import { Card, Button, Collapse } from 'react-bootstrap';
import { AlertTriangle, WifiOff, RefreshCw, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * ErrorCard — Human-friendly, informative error and connection-failure component.
 * Displays a clear description of the issue, actionable advice (e.g. VPN hints),
 * and an expandable technical details section with a one-click copy button for admins.
 */
const ErrorCard = ({
  title,
  message,
  error,
  onRetry,
  isNetworkError = false,
  className = 'my-4'
}) => {
  const { lang } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const errorString = error
    ? (typeof error === 'object' ? (error.stack || error.message || JSON.stringify(error)) : String(error))
    : '';

  const defaultTitle = isNetworkError
    ? (lang === 'ru' ? 'Ошибка соединения с сервером' : 'Server Connection Error')
    : (lang === 'ru' ? 'Не удалось загрузить данные' : 'Failed to Load Data');

  const defaultMessage = isNetworkError
    ? (lang === 'ru'
        ? 'Не удалось установить соединение с сервером. Пожалуйста, проверьте подключение к интернету или попробуйте обновить страницу.'
        : 'Unable to connect to the server. Please check your internet connection or try refreshing the page.')
    : (lang === 'ru'
        ? 'Произошла непредвиденная ошибка при получении данных. Попробуйте обновить страницу или повторить попытку.'
        : 'An unexpected error occurred while fetching data. Please try refreshing or retrying.');

  const handleCopy = () => {
    const report = [
      `=== AERUN ERROR REPORT ===`,
      `Time: ${new Date().toISOString()}`,
      `URL: ${window.location.href}`,
      `Title: ${title || defaultTitle}`,
      `Error: ${errorString}`,
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
          {isNetworkError ? <WifiOff size={36} /> : <AlertTriangle size={36} />}
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
