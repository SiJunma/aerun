import React, { useState, useEffect, useMemo } from 'react';
import { Form, Button } from 'react-bootstrap';
import ForumModal from '../common/ForumModal';
import { subscribeToCategoryGroups } from '../../api/categories';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { resolveField } from '../../utils/text';

const MoveTopicsModal = ({ show, onHide, onConfirm, topicCount, excludeCategoryId }) => {
  const { t, lang } = useI18n();
  const { hasPermission, PERMISSIONS, categories: allCategories } = useAuth();
  const [groups, setGroups] = useState([]);
  const [targetId, setTargetId] = useState('');

  // Filter categories from context (derived during render, no effect needed).
  const categories = useMemo(() => allCategories.filter(cat => {
    const isExcluded = excludeCategoryId && cat.id === excludeCategoryId;
    if (isExcluded) return false;
    return hasPermission(PERMISSIONS.VIEW_FORUM, { category: cat });
  }), [allCategories, excludeCategoryId, hasPermission, PERMISSIONS.VIEW_FORUM]);

  // Reset the selection when the modal is (re)opened. Resetting during render
  // (instead of inside an effect) avoids a cascading render.
  const [prevShow, setPrevShow] = useState(show);
  if (show !== prevShow) {
    setPrevShow(show);
    if (show) setTargetId('');
  }

  useEffect(() => {
    if (show) {
      const unsubGroups = subscribeToCategoryGroups((grps) => {
        setGroups(grps);
      });

      return () => {
        unsubGroups();
      };
    }
  }, [show]);

  const handleConfirm = () => {
    if (targetId) {
      onConfirm(targetId);
      onHide();
    }
  };

  const groupsWithCats = groups.filter(g => categories.some(c => c.group_id === g.id));
  const uncategorizedCats = categories.filter(c => !c.group_id || !groups.some(g => g.id === c.group_id));

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
          ? `Выберите форум, в который вы хотите перенести выбранные темы (${topicCount}):`
          : `Select the target forum for the selected topics (${topicCount}):`}
      </div>
      <Form.Select 
        value={targetId} 
        onChange={(e) => setTargetId(e.target.value)}
        className="mb-2"
      >
        <option value="">{lang === 'ru' ? 'Выберите форум...' : 'Select forum...'}</option>
        {groupsWithCats.map(group => (
          <optgroup key={group.id} label={resolveField(group.title, lang)}>
            {categories
              .filter(cat => cat.group_id === group.id)
              .map(cat => (
                <option key={cat.id} value={cat.id}>
                  {resolveField(cat.title, lang)}
                </option>
              ))}
          </optgroup>
        ))}
        {uncategorizedCats.length > 0 && (
          <optgroup label={lang === 'ru' ? 'Без категории' : 'Uncategorized'}>
            {uncategorizedCats.map(cat => (
              <option key={cat.id} value={cat.id}>
                {resolveField(cat.title, lang)}
              </option>
            ))}
          </optgroup>
        )}
      </Form.Select>
    </ForumModal>
  );
};

export default MoveTopicsModal;
