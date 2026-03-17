import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { Container, Card, Table, Button, Badge, Row, Col, Form, Toast, ToastContainer } from 'react-bootstrap';
import { Trash2, Move, Settings, CheckSquare, XSquare, Pin, Lock, PlusCircle, Search, MessageSquare, Clock, Filter, FolderInput, Unlock, CheckCircle } from 'lucide-react';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { 
  subscribeToTopics, 
  subscribeToCategories, 
  batchUpdateTopics, 
  deleteTopics,
  moveTopics
} from '../api/forum';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumPagination from '../components/common/ForumPagination';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import TopicRow from '../components/common/TopicRow';
import MoveTopicsModal from '../components/modals/MoveTopicsModal';
import ConfirmModal from '../components/common/ConfirmModal';

const CategoryPage = () => {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { profile, user, hasPermission, PERMISSIONS } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [category, setCategory] = useState(null);
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);

  // Management State
  const [isManaging, setIsManaging] = useState(false);
  const [selectedTopicIds, setSelectedTopicIds] = useState([]);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [toast, setToast] = useState({ show: false, message: '', variant: 'success' });

  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  const isStaff = hasPermission(PERMISSIONS.MODERATE_CONTENT);

  useEffect(() => {
    const unsubCat = subscribeToCategories((cats) => {
      const found = cats.find(c => c.id === id);
      if (found) setCategory(found);
    });

    const unsubTopics = subscribeToTopics(id, (data) => {
      setTopics(data);
      setLoading(false);
    });

    return () => {
      unsubCat();
      unsubTopics();
    };
  }, [id]);

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';


  const categoryTitle = category ? resolveText(category.title) : '...';

  // Pagination logic
  const totalPages = Math.ceil(topics.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTopics = topics.slice(indexOfFirstItem, indexOfLastItem);

  const handlePageChange = (page) => {
    setSearchParams({ page });
  };

  // Management Handlers
  const toggleSelect = (topicId) => {
    setSelectedTopicIds(prev => 
      prev.includes(topicId) ? prev.filter(id => id !== topicId) : [...prev, topicId]
    );
  };

  const selectAll = () => {
    if (selectedTopicIds.length === currentTopics.length) {
      setSelectedTopicIds([]);
    } else {
      setSelectedTopicIds(currentTopics.map(t => t.id));
    }
  };

  const handleBatchPin = async (pinned) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await batchUpdateTopics(selectedTopicIds, { is_pinned: pinned });
      setToast({
        show: true,
        message: lang === 'ru' 
          ? (pinned ? 'Темы закреплены' : 'Темы откреплены') 
          : (pinned ? 'Topics pinned' : 'Topics unpinned'),
        variant: 'success'
      });
    } catch (error) {
      setToast({ show: true, message: error.message, variant: 'danger' });
    }
  };

  const handleBatchLock = async (locked) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await batchUpdateTopics(selectedTopicIds, { is_locked: locked });
      setToast({
        show: true,
        message: lang === 'ru' 
          ? (locked ? 'Темы закрыты' : 'Темы открыты') 
          : (locked ? 'Topics locked' : 'Topics unlocked'),
        variant: 'success'
      });
    } catch (error) {
      setToast({ show: true, message: error.message, variant: 'danger' });
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTopicIds.length === 0) return;
    try {
      await deleteTopics(selectedTopicIds);
      setToast({
        show: true,
        message: lang === 'ru' ? 'Темы удалены' : 'Topics deleted',
        variant: 'success'
      });
      setSelectedTopicIds([]);
    } catch (error) {
      setToast({ show: true, message: error.message, variant: 'danger' });
    }
  };

  const handleConfirmMove = async (targetCatId) => {
    if (selectedTopicIds.length === 0) return;
    try {
      await moveTopics(selectedTopicIds, targetCatId);
      setToast({
        show: true,
        message: lang === 'ru' ? 'Темы перенесены' : 'Topics moved',
        variant: 'success'
      });
      setSelectedTopicIds([]);
      setIsManaging(false);
    } catch (error) {
      setToast({ show: true, message: error.message, variant: 'danger' });
    }
  };

  return (
    <Container className="py-4 position-relative">
      <ForumBreadcrumbs 
        items={[{ label: categoryTitle, active: true }]} 
      />

      <div className="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center gap-3 mb-4">
        <div>
          <h2 className="mb-1">{categoryTitle}</h2>
          {category?.description && (
            <div className="text-muted mb-0" style={{ lineHeight: 1.2, fontSize: '0.875rem' }}>
              {resolveText(category.description)}
            </div>
          )}
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {isStaff && (
            <Button 
              variant={isManaging ? "secondary" : "outline-primary"}
              onClick={() => {
                setIsManaging(!isManaging);
                setSelectedTopicIds([]);
              }}
              className="d-flex align-items-center gap-2"
            >
              <Settings size={18} />
              {lang === 'ru' ? (isManaging ? 'Готово' : 'Управление') : (isManaging ? 'Done' : 'Manage')}
            </Button>
          )}
          {profile?.role_id !== 'spectator' && (
            <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
              {t('forum.create_topic')}
            </Button>
          )}
        </div>
      </div>

      <Card className="shadow-sm border-0">
        {loading ? (
          <div className="p-5 text-center text-muted">
            <div className="spinner-border spinner-border-sm me-2" role="status" />
            {lang === 'ru' ? 'Загрузка...' : 'Loading...'}
          </div>
        ) : topics.length === 0 ? (
          <div className="p-5 text-center">
            <div className="mb-3" style={{ fontSize: '3rem', opacity: 0.3 }}>💬</div>
            <h5 className="text-muted mb-2">
              {lang === 'ru' ? 'Тем пока нет' : 'No topics yet'}
            </h5>
            <p className="text-muted mb-4" style={{ fontSize: '0.875rem' }}>
              {lang === 'ru'
                ? 'Будь первым — создай тему!'
                : 'Be the first to start a discussion!'}
            </p>
            {profile?.role_id !== 'spectator' && (
              <Button as={Link} to={`/category/${id}/new-topic`} variant="primary">
                {t('forum.create_topic')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <Table hover responsive className="mb-0 align-middle">
              <thead>
                <tr>
                  {isManaging && (
                    <th style={{ width: '40px' }}>
                      <Form.Check 
                        type="checkbox"
                        checked={selectedTopicIds.length === currentTopics.length && currentTopics.length > 0}
                        onChange={selectAll}
                      />
                    </th>
                  )}
                  <th style={{ width: '50%' }}>{t('forum.topic')}</th>
                  <th className="text-center">{t('forum.replies')}</th>
                  {/* <th className="text-center">{t('forum.views')}</th> */}
                  <th>{t('forum.last_post')}</th>
                </tr>
              </thead>
              <tbody>
                {currentTopics.map(topic => (
                  <TopicRow 
                    key={topic.id}
                    topic={topic}
                    user={user}
                    lang={lang}
                    isManaging={isManaging}
                    isSelected={selectedTopicIds.includes(topic.id)}
                    onSelect={toggleSelect}
                  />
                ))}
              </tbody>
            </Table>
            {totalPages > 1 && (
              <div className="p-3 d-flex justify-content-center border-top">
                <ForumPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                />
              </div>
            )}
          </>
        )}
      </Card>

      {/* Management Toolbar */}
      {isManaging && selectedTopicIds.length > 0 && (
        <div className="management-toolbar user-select-none">
          <div className="me-2 small fw-bold">
            {lang === 'ru' ? `Выбрано: ${selectedTopicIds.length}` : `Selected: ${selectedTopicIds.length}`}
          </div>
          <div className="vr d-none d-md-block mx-2"></div>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(true)}>
            <Pin size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Закрепить' : 'Pin'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchPin(false)}>
            <XSquare size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Открепить' : 'Unpin'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(true)}>
            <Lock size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Закрыть' : 'Lock'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => handleBatchLock(false)}>
            <CheckSquare size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Открыть' : 'Unlock'}</span>
          </Button>
          <Button variant="outline-light" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowMoveModal(true)}>
            <Move size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Перенести' : 'Move'}</span>
          </Button>
          <Button variant="danger" size="sm" className="d-flex align-items-center gap-1" onClick={() => setShowDeleteModal(true)}>
            <Trash2 size={16} /> <span className="d-none d-lg-inline">{lang === 'ru' ? 'Удалить' : 'Delete'}</span>
          </Button>
        </div>
      )}

      <ConfirmModal 
        show={showDeleteModal}
        onHide={() => setShowDeleteModal(false)}
        onConfirm={handleBatchDelete}
        title={lang === 'ru' ? 'Удалить темы?' : 'Delete topics?'}
        message={lang === 'ru' 
          ? `Вы уверены, что хотите навсегда удалить выбранные темы (${selectedTopicIds.length})? Это действие нельзя отменить.` 
          : `Are you sure you want to permanently delete the selected topics (${selectedTopicIds.length})? This action cannot be undone.`
        }
        confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
      />

      <MoveTopicsModal 
        show={showMoveModal}
        onHide={() => setShowMoveModal(false)}
        onConfirm={handleConfirmMove}
        topicCount={selectedTopicIds.length}
        excludeCategoryId={id}
      />

      <div className="mt-4">
        <Link to="/" className="btn btn-outline-secondary">
          &larr; {t('forum.back_to_categories')}
        </Link>
      </div>

      <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 1100, position: 'fixed' }}>
        <Toast
          bg={toast.variant}
          show={toast.show}
          onClose={() => setToast(t => ({ ...t, show: false }))}
          delay={3500}
          autohide
        >
          <Toast.Body className="d-flex align-items-center gap-2 text-white fw-semibold">
            <span>{toast.variant === 'success' ? '✓' : '✕'}</span>
            <span>{toast.message}</span>
          </Toast.Body>
        </Toast>
      </ToastContainer>
    </Container>
  );
};

export default CategoryPage;
