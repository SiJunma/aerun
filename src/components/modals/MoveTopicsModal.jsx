import React, { useState, useEffect } from 'react';
import { Form, Button } from 'react-bootstrap';
import ForumModal from '../common/ForumModal';
import { subscribeToCategories } from '../../api/forum';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';

const MoveTopicsModal = ({ show, onHide, onConfirm, topicCount, excludeCategoryId }) => {
  const { t, lang } = useI18n();
  const { hasPermission, PERMISSIONS } = useAuth();
  const [categories, setCategories] = useState([]);
  const [targetId, setTargetId] = useState('');

  useEffect(() => {
    if (show) {
      return subscribeToCategories((cats) => {
        const filtered = cats.filter(cat => {
          const isExcluded = excludeCategoryId && cat.id === excludeCategoryId;
          if (isExcluded) return false;
          
          // Check if user has permission to see this folder
          return hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
        });
        setCategories(filtered);
      });
    }
  }, [show, excludeCategoryId, hasPermission, PERMISSIONS.VIEW_FORUM]);

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';

  const handleConfirm = () => {
    if (targetId) {
      onConfirm(targetId);
      onHide();
    }
  };

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={lang === 'ru' ? 'Перенос тем' : 'Move Topics'}
      footer={
        <>
          <Button variant="link" onClick={onHide} className="text-decoration-none text-muted">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!targetId}>
            {lang === 'ru' ? 'Перенести' : 'Move'}
          </Button>
        </>
      }
    >
      <div className="mb-3">
        {lang === 'ru' 
          ? `Выберите категорию, в которую вы хотите перенести выбранные темы (${topicCount}):`
          : `Select the target category for the selected topics (${topicCount}):`}
      </div>
      <Form.Select 
        value={targetId} 
        onChange={(e) => setTargetId(e.target.value)}
        className="mb-2"
      >
        <option value="">{lang === 'ru' ? 'Выберите категорию...' : 'Select category...'}</option>
        {categories.map(cat => (
          <option key={cat.id} value={cat.id}>
            {resolveText(cat.title)}
          </option>
        ))}
      </Form.Select>
    </ForumModal>
  );
};

export default MoveTopicsModal;
