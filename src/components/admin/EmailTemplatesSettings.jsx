import React, { useState, useEffect, useCallback } from 'react';
import { Card, Form, Button, Badge, Alert, Spinner } from 'react-bootstrap';
import { Mail, Eye, Send, RotateCcw, Save, AlertCircle, CheckCircle2, Code } from 'lucide-react';
import { useI18n } from '../../contexts/I18nProvider';
import { useToast } from '../../contexts/ToastProvider';
import { fetchEmailTemplates, updateEmailWrapper, sendTestEmail } from '../../api/admin';
import ForumModal from '../common/ForumModal';
import ConfirmModal from '../common/ConfirmModal';
import { HtmlEditorField } from './CodeEditorField';

const EmailTemplatesSettings = ({ forumName }) => {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [wrapper, setWrapper] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [defaultWrapper, setDefaultWrapper] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  // null until the field reports: a template that was never edited is
  // treated as valid, an HTML error blocks Save like a missing {CONTENT}.
  const [htmlValid, setHtmlValid] = useState(null);
  const handleHtmlValidity = useCallback((valid) => {
    setHtmlValid(valid);
  }, []);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const data = await fetchEmailTemplates();
      setWrapper(data.wrapper || '');
      setIsCustom(Boolean(data.is_custom));
      setDefaultWrapper(data.default_wrapper || '');
    } catch (err) {
      console.error('[EmailTemplatesSettings] Failed to fetch templates:', err);
      setFetchError(err.message || 'Failed to load email templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  const hasContentTag = wrapper.includes('{CONTENT}');

  // The editor is CodeMirror now, not a textarea: there is no caret to
  // restore, so a placeholder tag is appended at the end of the wrapper.
  const insertPlaceholder = (tag) => {
    setWrapper((prev) => (prev || '') + tag);
  };

  const handleSave = async () => {
    if (!hasContentTag) {
      showToast(t('admin.email_templates.content_required_error'), 'warning');
      return;
    }
    if (htmlValid === false) {
      showToast(t('admin.designs.validation_save_blocked'), 'warning');
      return;
    }
    try {
      setSaving(true);
      const res = await updateEmailWrapper(wrapper);
      setIsCustom(Boolean(res.is_custom));
      showToast(t('admin.email_templates.save_success'), 'success');
    } catch (err) {
      console.error('[handleSave email template]', err);
      showToast(err.message || t('admin.email_templates.save_error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleResetConfirm = async () => {
    try {
      setSaving(true);
      // Sending an empty string signals a reset on the backend.
      const res = await updateEmailWrapper('');
      setWrapper(res.wrapper || defaultWrapper);
      setIsCustom(false);
      showToast(t('admin.email_templates.save_success'), 'success');
    } catch (err) {
      console.error('[handleResetConfirm email template]', err);
      showToast(err.message || t('admin.email_templates.save_error'), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    try {
      setSendingTest(true);
      const res = await sendTestEmail();
      const email = res?.sent_to || 'your email';
      showToast(
        t('admin.email_templates.test_sent_success', { email }),
        'success'
      );
    } catch (err) {
      console.error('[handleSendTest]', err);
      showToast(
        err.message || t('admin.email_templates.test_sent_error'),
        'danger'
      );
    } finally {
      setSendingTest(false);
    }
  };

  // Generate preview HTML
  const generatePreviewHtml = () => {
    const title = t('admin.email_templates.sample_title');
    const appName = forumName || 'Aerun Forum';
    const sampleContent = t('admin.email_templates.sample_content');

    return (wrapper || defaultWrapper)
      .replace(/{TITLE}/g, title)
      .replace(/{APP_NAME}/g, appName)
      .replace(/{CONTENT}/g, sampleContent);
  };

  if (loading) {
    return (
      <Card className="shadow-sm border-0 mb-4">
        <Card.Body className="p-4 text-center text-muted">
          <Spinner animation="border" size="sm" className="me-2" />
          <span>{t('admin.settings.saving', 'Loading...')}</span>
        </Card.Body>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card className="shadow-sm border-0 mb-4">
        <Card.Body className="p-4">
          <Alert variant="danger" className="d-flex align-items-center justify-content-between mb-0">
            <div>
              <AlertCircle size={18} className="me-2" />
              <span>{fetchError}</span>
            </div>
            <Button variant="outline-danger" size="sm" onClick={loadTemplates}>
              Retry
            </Button>
          </Alert>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="shadow-sm border-0 mb-4">
      <Card.Body className="p-4">
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
          <div>
            <h5 className="mb-1 text-primary d-flex align-items-center gap-2">
              <Mail size={20} />
              {t('admin.email_templates.title')}
            </h5>
            <div className="small text-muted">
              {t('admin.email_templates.subtitle')}
            </div>
          </div>
          <div>
            {isCustom ? (
              <Badge bg="info" className="px-2 py-1 text-dark fw-semibold">
                <CheckCircle2 size={12} className="me-1" />
                {t('admin.email_templates.custom_badge')}
              </Badge>
            ) : (
              <Badge bg="secondary" className="px-2 py-1 opacity-75">
                {t('admin.email_templates.default_badge')}
              </Badge>
            )}
          </div>
        </div>

        {/* Placeholders bar */}
        <div className="p-3 mb-3 rounded bg-light border d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div className="small text-muted">
            <Code size={15} className="me-1 text-primary" />
            {t('admin.email_templates.placeholders_hint')}
          </div>
          <div className="d-flex gap-2">
            {['{TITLE}', '{APP_NAME}', '{CONTENT}'].map((tag) => (
              <Button
                key={tag}
                variant="outline-secondary"
                size="sm"
                className="py-0 px-2 font-monospace"
                style={{ fontSize: '12px' }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertPlaceholder(tag)}
                title={`Insert ${tag}`}
              >
                + {tag}
              </Button>
            ))}
          </div>
        </div>

        {/* Editor — HtmlEditorField (CodeMirror + HTML validation). Go
            directives ({{ .Content }}, {{ .Token }}) are plain text to the
            validator and pass it; the {CONTENT} tag check stays separate. */}
        <Form.Group className="mb-3" controlId="emailWrapperEditor">
          <HtmlEditorField
            id="emailWrapperEditor"
            label={t('admin.email_templates.wrapper_label')}
            value={wrapper}
            onChange={(val) => setWrapper(val)}
            onValidityChange={handleHtmlValidity}
            minHeight="280px"
          />
          {!hasContentTag && (
            <Form.Control.Feedback type="invalid" className="d-block mt-2">
              <AlertCircle size={14} className="me-1" />
              {t('admin.email_templates.content_required_error')}
            </Form.Control.Feedback>
          )}
        </Form.Group>

        {/* Action Buttons */}
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 pt-2 border-top">
          <div className="d-flex gap-2">
            <Button
              variant="outline-primary"
              size="sm"
              onClick={() => setShowPreview(true)}
              className="d-flex align-items-center gap-1"
            >
              <Eye size={15} />
              {t('admin.email_templates.preview_btn')}
            </Button>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={handleSendTest}
              disabled={sendingTest}
              className="d-flex align-items-center gap-1"
            >
              {sendingTest ? (
                <>
                  <Spinner animation="border" size="sm" />
                  {t('admin.email_templates.sending_test')}
                </>
              ) : (
                <>
                  <Send size={15} />
                  {t('admin.email_templates.send_test_btn')}
                </>
              )}
            </Button>
            {isCustom && (
              <Button
                variant="outline-warning"
                size="sm"
                onClick={() => setShowResetConfirm(true)}
                disabled={saving}
                className="d-flex align-items-center gap-1"
              >
                <RotateCcw size={15} />
                {t('admin.email_templates.reset_btn')}
              </Button>
            )}
          </div>

          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving || !hasContentTag || htmlValid === false}
            className="d-flex align-items-center gap-1 px-4"
          >
            {saving ? (
              <>
                <Spinner animation="border" size="sm" />
                {t('admin.email_templates.saving')}
              </>
            ) : (
              <>
                <Save size={15} />
                {t('admin.email_templates.save_btn')}
              </>
            )}
          </Button>
        </div>
      </Card.Body>

      {/* Preview Modal */}
      <ForumModal
        show={showPreview}
        onHide={() => setShowPreview(false)}
        title={t('admin.email_templates.preview_title')}
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setShowPreview(false)}>
            {t('common.cancel', 'Close')}
          </Button>
        }
      >
        <div
          className="border rounded overflow-hidden"
          style={{ height: '540px', background: '#f8fafc' }}
        >
          <iframe
            title="Email Preview"
            srcDoc={generatePreviewHtml()}
            style={{ width: '100%', height: '100%', border: 'none' }}
            sandbox="allow-same-origin"
          />
        </div>
      </ForumModal>

      {/* Reset Confirmation Modal */}
      <ConfirmModal
        show={showResetConfirm}
        onHide={() => setShowResetConfirm(false)}
        onConfirm={handleResetConfirm}
        title={t('admin.email_templates.reset_confirm_title')}
        message={t('admin.email_templates.reset_confirm_body')}
        variant="warning"
        confirmText={t('admin.email_templates.reset_btn')}
      />
    </Card>
  );
};

export default EmailTemplatesSettings;
