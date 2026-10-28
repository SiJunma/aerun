import { useState, useRef, useCallback } from 'react';
import { saveTopicDraft, publishDraft, deleteDraft } from '../../api/forum';
import { processDiceRolls } from '../../utils/dice';

/**
 * useTopicDraft: Custom hook for managing server-side topic drafts,
 * saving, updating, publishing, and deleting.
 */
export const useTopicDraft = ({
  topicId,
  showToast,
  t,
  lang,
  recordActivity
}) => {
  const [myDraft, setMyDraft] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const draftJustPublishedRef = useRef(false);

  const saveDraft = useCallback(async (content, selectedCharacterId, decorateDraftFn) => {
    if (!content?.trim() || draftSaving) return null;
    setDraftSaving(true);
    try {
      const { content: draftContent, rolls } = processDiceRolls(content.trim());
      const saved = await saveTopicDraft(topicId, draftContent, selectedCharacterId, rolls);
      const decorated = decorateDraftFn ? decorateDraftFn(saved, selectedCharacterId) : saved;
      setMyDraft(decorated);
      showToast?.(t?.('forum.draft_saved') || 'Draft saved');
      return decorated;
    } catch (err) {
      console.error('[saveDraft error]', err);
      showToast?.(t?.('forum.draft_save_error') || 'Failed to save draft', 'danger');
      throw err;
    } finally {
      setDraftSaving(false);
    }
  }, [topicId, draftSaving, showToast, t]);

  const updateDraft = useCallback(async (content, characterId, decorateDraftFn) => {
    if (draftSaving) return null;
    if (!content?.trim()) {
      showToast?.(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return null;
    }
    setDraftSaving(true);
    try {
      const existingRolls = myDraft?.rolls || {};
      const { content: draftContent, rolls: freshRolls } = processDiceRolls(content.trim());
      const saved = await saveTopicDraft(
        topicId,
        draftContent,
        characterId,
        { ...existingRolls, ...(freshRolls || {}) }
      );
      const decorated = decorateDraftFn ? decorateDraftFn(saved, characterId) : saved;
      setMyDraft(decorated);
      showToast?.(t?.('forum.draft_updated') || 'Draft updated');
      return decorated;
    } catch (err) {
      console.error('[updateDraft error]', err);
      showToast?.(t?.('forum.draft_update_error') || 'Failed to update draft', 'danger');
      throw err;
    } finally {
      setDraftSaving(false);
    }
  }, [topicId, draftSaving, myDraft?.rolls, showToast, t, lang]);

  const publishTopicDraft = useCallback(async (draftToPublish) => {
    const targetDraft = draftToPublish || myDraft;
    if (!targetDraft) return null;

    draftJustPublishedRef.current = true;
    setDraftSaving(true);
    recordActivity?.();

    try {
      const pubResult = await publishDraft(targetDraft.id);
      setMyDraft(null);
      showToast?.(t?.('forum.draft_published') || 'Draft published');
      return pubResult;
    } catch (err) {
      console.error('[publishTopicDraft error]', err);
      draftJustPublishedRef.current = false;
      showToast?.(t?.('forum.draft_publish_error') || 'Failed to publish draft', 'danger');
      throw err;
    } finally {
      setDraftSaving(false);
    }
  }, [myDraft, recordActivity, showToast, t]);

  const removeDraft = useCallback(async (draftId) => {
    const idToDelete = draftId || myDraft?.id;
    if (!idToDelete) return;
    try {
      await deleteDraft(idToDelete);
      setMyDraft(null);
    } catch (err) {
      console.error('[removeDraft error]', err);
      throw err;
    }
  }, [myDraft?.id]);

  return {
    myDraft,
    setMyDraft,
    draftSaving,
    setDraftSaving,
    saveDraft,
    updateDraft,
    publishTopicDraft,
    removeDraft,
    draftJustPublishedRef
  };
};

export default useTopicDraft;
