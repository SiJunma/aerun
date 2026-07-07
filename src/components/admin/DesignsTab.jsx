import React, { useState } from 'react';
import { Card, Button, Badge, Modal, Form, Row, Col } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { PlusCircle, Edit2, Trash2, Copy, Eye, EyeOff, Palette } from 'lucide-react';
import { createDesign, updateDesign, deleteDesign } from '../../api/designs';
import { useToast } from '../../contexts/ToastProvider';
import ConfirmModal from '../common/ConfirmModal';

const DesignsTab = ({ designs, settings, updateSettings, userId }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  
  const [showModal, setShowModal] = useState(false);
  const [editingDesign, setEditingDesign] = useState(null);
  const [form, setForm] = useState({
    name: '', description: '', logoUrl: '', forumTitle: '',
    welcomeMessage: '', css: '', js: '', showInList: true, isActive: true
  });
  
  const [confirmState, setConfirmState] = useState({
    show: false, title: '', message: '', onConfirm: () => {}
  });

  const [deactivateModal, setDeactivateModal] = useState({
    show: false,
    designIdToDeactivate: null,
    replacementId: ''
  });

  const handleOpenModal = (design = null) => {
    if (design) {
      setEditingDesign(design.id);
      setForm({
        name: design.name || '',
        description: design.description || '',
        logoUrl: design.logoUrl || '',
        forumTitle: design.forumTitle || '',
        welcomeMessage: design.welcomeMessage || '',
        css: design.css || '',
        js: design.js || '',
        showInList: design.showInList ?? true,
        isActive: design.isActive ?? true
      });
    } else {
      setEditingDesign(null);
      setForm({
        name: '', description: '', logoUrl: '', forumTitle: '',
        welcomeMessage: '', css: '', js: '', showInList: true, isActive: true
      });
    }
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    try {
      if (editingDesign) {
        await updateDesign(editingDesign, form);
      } else {
        await createDesign(form);
      }
      showToast(t('admin.designs.toast_saved'), 'success');
      setShowModal(false);
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleClone = async (design) => {
    try {
      const { id, ...data } = design;
      await createDesign({
        ...data,
        name: `${data.name} (Copy)`,
        isActive: false // Clones shouldn't be active immediately to avoid conflicts
      });
      showToast(t('admin.designs.toast_saved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const handleDelete = (design) => {
    if (design.isActive || settings.defaultDesignId === design.id) {
      showToast(t('admin.designs.cant_delete_active'), 'warning');
      return;
    }
    
    setConfirmState({
      show: true,
      title: t('admin.designs.confirm_delete_title'),
      message: t('admin.designs.confirm_delete_message'),
      onConfirm: async () => {
        try {
          await deleteDesign(design.id);
          showToast(t('admin.designs.toast_deleted'), 'success');
        } catch (err) {
          console.error(err);
          showToast(t('admin.designs.error_delete'), 'danger');
        }
      }
    });
  };

  const initiateDeactivate = (designId) => {
    if (settings.defaultDesignId === designId) {
      const available = designs.filter(d => d.id !== designId && d.isActive);
      setDeactivateModal({
        show: true,
        designIdToDeactivate: designId,
        replacementId: available.length > 0 ? available[0].id : ''
      });
    } else {
      // Just deactivate directly if it's not the default
      updateDesign(designId, { isActive: false }).catch(console.error);
    }
  };

  const handleConfirmDeactivate = async () => {
    const { designIdToDeactivate, replacementId } = deactivateModal;
    try {
      await updateDesign(designIdToDeactivate, { isActive: false });
      if (settings.defaultDesignId === designIdToDeactivate) {
        await updateSettings({ ...settings, defaultDesignId: replacementId });
      }
      setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' });
      showToast(t('admin.designs.toast_saved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('admin.designs.error_save'), 'danger');
    }
  };

  const toggleActivate = async (design) => {
    if (design.isActive) {
      initiateDeactivate(design.id);
    } else {
      try {
        await updateDesign(design.id, { isActive: true });
        showToast(t('admin.designs.toast_saved'), 'success');
      } catch (err) {
        console.error(err);
        showToast(t('admin.designs.error_save'), 'danger');
      }
    }
  };

  const handlePreview = (designId) => {
    window.open(`/?preview_design=${designId}`, '_blank');
  };

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h4 className="mb-0 text-primary d-flex align-items-center gap-2">
          <Palette size={24} /> {t('admin.designs.title')}
        </h4>
        <Button variant="primary" onClick={() => handleOpenModal()} className="d-flex align-items-center gap-2">
          <PlusCircle size={18} /> {t('admin.designs.create_btn')}
        </Button>
      </div>

      <Card className="shadow-sm border-0 mb-4 bg-light">
        <Card.Body>
          <Form.Check 
            type="switch"
            id="allow-custom-design"
            label={t('admin.designs.modal_show_in_list')} 
            // Note: Reuse a global label or add new one for the switch
            title="Allow users to choose their own design"
            checked={settings.allowUserCustomDesign}
            onChange={(e) => updateSettings({ ...settings, allowUserCustomDesign: e.target.checked })}
            className="mb-3 fw-bold"
          />
          <Form.Group>
            <Form.Label className="fw-bold">{t('admin.designs.default_design')}</Form.Label>
            <Form.Select 
              value={settings.defaultDesignId || ''} 
              onChange={(e) => updateSettings({ ...settings, defaultDesignId: e.target.value })}
              className="w-auto min-w-200"
            >
              <option value="">{t('admin.settings.default_design_none') || '-- No override --'}</option>
              <optgroup label={t('admin.settings.default_design_builtin') || 'Built-in Themes'}>
                <option value="dark">{t('profile.theme_dark') || 'Dark'}</option>
                <option value="light">{t('profile.theme_light') || 'Light'}</option>
                <option value="neutral">{t('profile.theme_neutral') || 'Neutral'}</option>
              </optgroup>
              {designs.filter(d => d.isActive).length > 0 && (
                <optgroup label={t('admin.settings.default_design_custom') || 'Custom Designs'}>
                  {designs.filter(d => d.isActive).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </optgroup>
              )}
            </Form.Select>
          </Form.Group>
        </Card.Body>
      </Card>

      <Row className="g-4">
        {designs.map(design => (
          <Col md={6} lg={4} key={design.id}>
            <Card className={`shadow-sm h-100 ${!design.isActive ? 'opacity-75 bg-light' : ''}`}>
              <Card.Body className="d-flex flex-column">
                <div className="d-flex justify-content-between align-items-start mb-2">
                  <h5 className="mb-0 fw-bold">{design.name}</h5>
                  <Badge bg={design.isActive ? 'success' : 'secondary'}>
                    {design.isActive ? t('admin.designs.active') : t('admin.designs.inactive')}
                  </Badge>
                </div>
                <p className="text-muted small flex-grow-1">{design.description}</p>
                
                <div className="d-flex gap-2 mt-3 flex-wrap">
                  <Button variant={design.isActive ? 'outline-warning' : 'outline-success'} size="sm" onClick={() => toggleActivate(design)} title={design.isActive ? t('admin.designs.deactivate') : t('admin.designs.activate')}>
                    {design.isActive ? <EyeOff size={16} /> : <Eye size={16} />}
                  </Button>
                  <Button variant="outline-primary" size="sm" onClick={() => handlePreview(design.id)} title={t('admin.designs.preview')}>
                    <Palette size={16} />
                  </Button>
                  <Button variant="outline-secondary" size="sm" onClick={() => handleOpenModal(design)} title={t('admin.designs.edit')}>
                    <Edit2 size={16} />
                  </Button>
                  <Button variant="outline-info" size="sm" onClick={() => handleClone(design)} title={t('admin.designs.clone')}>
                    <Copy size={16} />
                  </Button>
                  <Button variant="outline-danger" size="sm" onClick={() => handleDelete(design)} title={t('admin.designs.delete')}>
                    <Trash2 size={16} />
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Edit/Create Modal */}
      <Modal show={showModal} onHide={() => setShowModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>{editingDesign ? t('admin.designs.modal_edit') : t('admin.designs.modal_create')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label className="fw-bold">{t('admin.designs.modal_name')}</Form.Label>
                  <Form.Control type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label className="fw-bold">{t('admin.designs.modal_logo')}</Form.Label>
                  <Form.Control type="text" value={form.logoUrl} onChange={e => setForm({...form, logoUrl: e.target.value})} placeholder="https://..." />
                </Form.Group>
              </Col>
            </Row>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold">{t('admin.designs.modal_desc')}</Form.Label>
              <Form.Control as="textarea" rows={2} value={form.description} onChange={e => setForm({...form, description: e.target.value})} />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold">{t('admin.designs.modal_title')}</Form.Label>
              <Form.Control type="text" value={form.forumTitle} onChange={e => setForm({...form, forumTitle: e.target.value})} />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold">{t('admin.designs.modal_welcome')}</Form.Label>
              <Form.Control as="textarea" rows={3} className="font-monospace" value={form.welcomeMessage} onChange={e => setForm({...form, welcomeMessage: e.target.value})} />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold">{t('admin.designs.modal_css')}</Form.Label>
              <Form.Control as="textarea" rows={5} className="font-monospace" value={form.css} onChange={e => setForm({...form, css: e.target.value})} />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label className="fw-bold">{t('admin.designs.modal_js')}</Form.Label>
              <Form.Control as="textarea" rows={3} className="font-monospace" value={form.js} onChange={e => setForm({...form, js: e.target.value})} />
            </Form.Group>

            <Form.Check 
              type="switch"
              id="show-in-list"
              label={t('admin.designs.modal_show_in_list')}
              checked={form.showInList}
              onChange={e => setForm({...form, showInList: e.target.checked})}
              className="fw-bold"
            />
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!form.name.trim()}>{t('admin.designs.save_btn')}</Button>
        </Modal.Footer>
      </Modal>

      {/* Deactivate Replacement Modal */}
      <Modal show={deactivateModal.show} onHide={() => setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' })}>
        <Modal.Header closeButton>
          <Modal.Title>{t('admin.designs.confirm_deactivate_title')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>{t('admin.designs.confirm_deactivate_message')}</p>
          <Form.Group>
            <Form.Label className="fw-bold">{t('admin.designs.select_replacement')}</Form.Label>
            <Form.Select 
              value={deactivateModal.replacementId} 
              onChange={e => setDeactivateModal({ ...deactivateModal, replacementId: e.target.value })}
            >
              <optgroup label={t('admin.settings.default_design_builtin') || 'Built-in Themes'}>
                <option value="dark">{t('profile.theme_dark') || 'Dark'}</option>
                <option value="light">{t('profile.theme_light') || 'Light'}</option>
                <option value="neutral">{t('profile.theme_neutral') || 'Neutral'}</option>
              </optgroup>
              {designs.filter(d => d.isActive && d.id !== deactivateModal.designIdToDeactivate).length > 0 && (
                <optgroup label={t('admin.settings.default_design_custom') || 'Custom Designs'}>
                  {designs.filter(d => d.isActive && d.id !== deactivateModal.designIdToDeactivate).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </optgroup>
              )}
            </Form.Select>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDeactivateModal({ show: false, designIdToDeactivate: null, replacementId: '' })}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleConfirmDeactivate}>{t('common.confirm')}</Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={confirmState.show}
        title={confirmState.title}
        message={confirmState.message}
        onConfirm={confirmState.onConfirm}
        onHide={() => setConfirmState(prev => ({ ...prev, show: false }))}
      />
    </>
  );
};

export default DesignsTab;
