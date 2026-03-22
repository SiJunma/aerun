import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Button, Form, Modal, Pagination, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { subscribeToPosts, createPost, updatePost, deletePost, subscribeToTopic, subscribeToCategories, subscribeToUser, updateUser, updateTopic, deleteTopics, moveTopics, createDraftPost, updateDraftPost, publishDraft, subscribeToTopicDraft, deleteDraftPost } from '../api/forum';
import { subscribeToCharacters, subscribeToCharacter } from '../api/character';
import ConfirmModal from '../components/common/ConfirmModal';
import ForumModal from '../components/common/ForumModal';
import MoveTopicsModal from '../components/modals/MoveTopicsModal';
import RichEditor from '../components/common/RichEditor';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import BBCode from '../components/common/BBCode';
import {
  Award, Pin, Lock, Settings, Trash2, ArrowRightLeft, Bell, BellOff, MessageSquare, Send,
  Search, Filter, ChevronUp, ChevronDown, Heart, Flag, Share2, MoreHorizontal,
  Dices, User, FilePen, MessageSquareOff
} from 'lucide-react';
import { voteOnPost, getVotesInTopic } from '../api/reputation';
import { subscribeToTopicStatus, toggleSubscription } from '../api/subscriptions';
import ForumPagination from '../components/common/ForumPagination';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumAuthorAvatar from '../components/common/ForumAuthorAvatar';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import Skeleton from '../components/common/Skeleton';
import { useToast } from '../contexts/ToastProvider';


const TopicPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { t, lang } = useI18n();
  const { profile, user, recordActivity, markTopicRead, readMap, hasPermission, PERMISSIONS, settings } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [replyContent, setReplyContent] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [topic, setTopic] = useState(null);
  const [category, setCategory] = useState(null);
  const [posts, setPosts] = useState([]);
  const [myDraft, setMyDraft] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [authorStats, setAuthorStats] = useState({}); // { uid: { post_count: N } }
  const [maskStats, setMaskStats] = useState({}); // { charId: { status_line: '' } }

  // Edit state
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState('');
  // Extra fields when editing the first post (topic title/description)
  const [editTopicTitle, setEditTopicTitle] = useState('');
  const [editTopicDescription, setEditTopicDescription] = useState('');
  const [editingFirstPost, setEditingFirstPost] = useState(false);

  // Delete confirmation state
  const [deletingPost, setDeletingPost] = useState(null);
  const [showDeleteTopicModal, setShowDeleteTopicModal] = useState(false);

  // Reputation state
  const [myVotes, setMyVotes] = useState({}); // { postId: value }
  const [votingPostId] = useState(null);
  const [showRepModal, setShowRepModal] = useState(false);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [submittingRep, setSubmittingRep] = useState(false);
  const [repTargetPost, setRepTargetPost] = useState(null);
  const [repTargetPostNumber, setRepTargetPostNumber] = useState(null);
  const [activeRepPostId, setActiveRepPostId] = useState(null);
  const [showVoteInfoModal, setShowVoteInfoModal] = useState(false);
  const [selectedVote, setSelectedVote] = useState(null);
  
  // Subscription state
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [togglingSub, setTogglingSub] = useState(false);

  // Move Topic state
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(true);

  const replyRef = useRef(null);
 // prevent double-scroll
  const goLast = searchParams.get('goLast') === '1';
  const LAST_VISIT_KEY = `lastVisit_${id}`; // kept for legacy scroll-to-unread fallback logic (now uses readMap)
  const ITEMS_PER_PAGE = 20;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);
  const MAX_CHARS = 15000;

  const totalPagesLocal = Math.ceil(posts.length / ITEMS_PER_PAGE);
  const isOnLastPageLocal = totalPagesLocal === 0 || currentPage >= totalPagesLocal;


  useEffect(() => {
    const unsubPosts = subscribeToPosts(id, setPosts);
    const unsubTopic = subscribeToTopic(id, setTopic);

    return () => {
      unsubPosts();
      unsubTopic();
    };
  }, [id]);

  // Only mark the topic as read if the user is currently on the last page.
  useEffect(() => {
    if (user && id && posts.length > 0 && isOnLastPageLocal) {
      markTopicRead(id);
    }
  }, [posts.length, id, user, markTopicRead, isOnLastPageLocal]);

  // Subscribe to draft
  useEffect(() => {
    if (!user || !id) return;
    const unsub = subscribeToTopicDraft(id, user.uid, setMyDraft);
    return () => unsub();
  }, [user, id]);

  // Subscribe to characters separately so we can unsubscribe properly
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToCharacters(user.uid, setCharacters);

    // Fetch my votes in this topic
    getVotesInTopic(user.uid, id).then(setMyVotes).catch(console.error);

    return () => unsub();
  }, [user, id]);

  useEffect(() => {
    if (!user || !id || profile?.status !== 'active') return;
    const unsub = subscribeToTopicStatus(id, user.uid, setIsSubscribed);
    return () => unsub();
  }, [user, id, profile?.status]);

  // Set initial selectedCharacterId from profile
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.last_selected_character_id]);

  useEffect(() => {
    const unsubCat = subscribeToCategories((cats) => {
      if (topic?.category_id) {
        const found = cats.find(c => c.id === topic.category_id);
        if (found) setCategory(found);
      }
    });
    return () => unsubCat();
  }, [topic?.category_id]);

  // ── Jump to Specific Post ───────────────────────────────────────────────
  useEffect(() => {
    const postId = searchParams.get('post');
    if (postId && posts.length > 0) {
      const index = posts.findIndex(p => p.id === postId);
      if (index !== -1) {
        const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
        if (targetPage !== currentPage) {
          setSearchParams(curr => {
            curr.set('page', targetPage);
            return curr;
          });
        } else {
          // Already on correct page, scroll to it
          setTimeout(() => {
            const el = document.getElementById(`post-${postId}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('highlight-new-post');
              setTimeout(() => el.classList.remove('highlight-new-post'), 2000);
            }
          }, 500);
        }
      }
    }
  }, [posts, searchParams, currentPage, ITEMS_PER_PAGE, setSearchParams]);

  // Draft Auto-save
  const DRAFT_KEY = `reply_draft_${id}`;

  useEffect(() => {
    const savedDraft = localStorage.getItem(DRAFT_KEY);
    if (savedDraft) {
      setReplyContent(savedDraft);
    }
  }, [id, DRAFT_KEY]);

  useEffect(() => {
    if (replyContent) {
      localStorage.setItem(DRAFT_KEY, replyContent);
    } else {
      localStorage.removeItem(DRAFT_KEY);
    }
  }, [replyContent, DRAFT_KEY]);

  // Subscribe to author stats for each unique author in posts
  useEffect(() => {
    if (posts.length === 0) return;
    const uniqueAuthorIds = [...new Set(posts.map(p => p.author_id))];
    const unsubs = uniqueAuthorIds.map(uid => {
      return subscribeToUser(uid, (data) => {
        // We store 'null' explicitly to signal that the fetch finished but returned no user (Deleted)
        setAuthorStats(prev => ({ ...prev, [uid]: data || null }));
      });
    });
    return () => unsubs.forEach(unsub => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length > 0 ? [...new Set(posts.map(p => p.author_id))].join(',') : '']);

  // Subscribe to character masks
  useEffect(() => {
    if (posts.length === 0) return;
    const characterMasks = posts.filter(p => p.is_character && p.author_character_id);
    const uniqueMasks = [...new Set(characterMasks.map(p => `${p.author_id}_${p.author_character_id}`))];
    
    const unsubs = uniqueMasks.map(key => {
      const [uid, charId] = key.split('_');
      return subscribeToCharacter(uid, charId, (data) => {
        setMaskStats(prev => ({ ...prev, [charId]: data || null }));
      });
    });
    
    return () => unsubs.forEach(unsub => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length > 0 ? [...new Set(posts.filter(p => p.is_character).map(p => p.author_character_id))].join(',') : '']);



  // Scroll to last post if ?goLast=1, or specific post if #post-ID
  const lastTargetRef = useRef('');

  useEffect(() => {
    if (posts.length === 0) {
      if (!isPageLoading) setIsPageLoading(true);
      return;
    }

    let targetId = null;
    let targetPage = currentPage;
    const currentHash = hash;

    if (currentHash && currentHash.startsWith('#post-')) {
      const postId = currentHash.replace('#post-', '');
      const postIndex = posts.findIndex(p => p.id === postId);
      if (postIndex !== -1) {
        targetPage = Math.ceil((postIndex + 1) / ITEMS_PER_PAGE);
        if (currentPage !== targetPage) {
          // Navigating while preserving hash
          setIsPageLoading(true);
          navigate({
            search: `?page=${targetPage}${goLast ? '&goLast=0' : ''}`,
            hash: currentHash
          });
          return;
        }
        targetId = currentHash.substring(1); // remove #
      }
    } else if (goLast) {
      let finalTargetPage = Math.ceil(posts.length / ITEMS_PER_PAGE) || 1;
      let finalTargetId = posts.length > 0 ? `post-${posts[posts.length - 1].id}` : null;

      if (user) {
        const lastVisitRaw = readMap[id];
        const registrationMs = profile?.created_at?.toMillis?.() || 0;
        const lastVisit = Math.max(
          lastVisitRaw?.toMillis ? lastVisitRaw.toMillis() : (lastVisitRaw || 0),
          registrationMs
        );
        const unreadIndex = posts.findIndex(p => (p.created_at?.toMillis?.() || 0) > lastVisit);
        
        if (unreadIndex !== -1) {
          finalTargetPage = Math.ceil((unreadIndex + 1) / ITEMS_PER_PAGE);
          finalTargetId = `post-${posts[unreadIndex].id}`;
        }
      }

      if (currentPage !== finalTargetPage) {
        setIsPageLoading(true);
        setSearchParams({ page: finalTargetPage, goLast: '1' });
        return;
      }
      targetPage = finalTargetPage;
      targetId = finalTargetId;
    } else {
      setIsPageLoading(false);
    }

    setIsPageLoading(false);

    // Only scroll if it's a new mount or a new target
    const fullTargetKey = `${id}_${targetPage}_${targetId}`;
    if (targetId && lastTargetRef.current !== fullTargetKey) {
      lastTargetRef.current = fullTargetKey;
      let attempts = 0;
      const tryScroll = () => {
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.add('highlight-new-post');
          setTimeout(() => el.classList.remove('highlight-new-post'), 1000);
        } else if (attempts < 15) {
          attempts++;
          setTimeout(tryScroll, 200);
        }
      };
      setTimeout(tryScroll, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length, goLast, currentPage, hash, id, readMap, profile]);
  const formatTime = (timestamp) => {
    if (!timestamp) return '...';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '...';
    }
  };

  const getLiveOwnerName = (post) => {
    if (post.author_id === user?.uid) {
      return profile?.nickname || post.owner_name;
    }
    return authorStats[post.author_id]?.nickname || post.owner_name;
  };

  const handleQuoteAuthor = (authorName) => {
    if (!user || profile?.role_id === 'spectator') return;
    
    const tag = `[b]${authorName}[/b],\n`;
    
    if (editingPostId) {
      setEditContent(prev => {
        const prefix = prev.trim() ? (prev.endsWith('\n') ? '' : '\n') : '';
        return prev + prefix + tag;
      });
      
      const id = (myDraft && editingPostId === myDraft.id) ? 'draftEditContent' : 'editContent';
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) {
          el.focus();
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
    } else {
      setReplyContent(prev => {
        const prefix = prev.trim() ? (prev.endsWith('\n') ? '' : '\n') : '';
        return prev + prefix + tag;
      });
      
      setTimeout(() => {
        const el = document.getElementById('replyContent');
        if (el) {
          el.focus();
        }
        replyRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  };

  const getLiveAuthorName = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char?.name || post.author_name;
      }
      return profile?.nickname || post.author_name;
    }
    if (post.is_character) return post.author_name;
    return authorStats[post.author_id]?.nickname || post.author_name;
  };


  const getLiveAuthorStatus = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.status_line || '') : (post.author_status_line || '');
      }
      return profile ? (profile.status_line || '') : (post.author_status_line || '');
    }
    
    if (post.is_character) {
      if (post.author_character_id) {
        if (!(post.author_character_id in maskStats)) return 'LOADING';
        const stats = maskStats[post.author_character_id];
        if (stats === null) return post.author_status_line || '';
        return stats.status_line || '';
      }
      return post.author_status_line || '';
    }
    
    // Check if we have entries in authorStats for this UID
    if (!(post.author_id in authorStats)) {
      // Not yet loaded or even started fetching? (Should be handled by useEffect but safety first)
      return 'LOADING';
    }

    const stats = authorStats[post.author_id];
    if (stats === null) {
      // Fetch finished but returned nothing (User deleted)
      return post.author_status_line || '';
    }

    // Live data found
    return stats.status_line || '';
  };

  const getLiveAuthorSignature = (post) => {
    if (post.author_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.signature || '') : (post.author_signature || '');
      }
      return profile?.settings?.signature || post.author_signature || '';
    }
    if (post.is_character) return post.author_signature || '';
    const stats = authorStats[post.author_id];
    return (stats && stats.nickname) ? (stats.settings?.signature || '') : (post.author_signature || '');
  };

  const resolveText = (field) =>
    typeof field === 'object' && field !== null
      ? (lang === 'ru' ? field.ru : field.en) || ''
      : field || '';


  const handleOpenVoteModal = (post, value, postNumber) => {
    if (!user || profile?.role_id === 'spectator') return;
    if (post.author_id === user.uid) return;
    if (myVotes[post.id]) return;

    setRepTargetPost(post);
    setRepValue(value);
    setRepTargetPostNumber(postNumber);
    setRepComment('');
    setShowRepModal(true);
  };

  const handleRepVote = async () => {
    if (!repTargetPost || !user) return;
    setSubmittingRep(true);
    try {
      await voteOnPost(user.uid, repTargetPost.author_id, repTargetPost.id, id, repValue, repComment, topic?.title, repTargetPostNumber);
      setShowRepModal(false); // Close AFTER success
      setMyVotes(prev => ({
        ...prev,
        [repTargetPost.id]: {
          value: repValue,
          comment: repComment,
          voter_nickname: profile?.nickname || user.displayName || 'User',
          topic_title: topic?.title || '',
          post_number: repTargetPostNumber,
          created_at: { toDate: () => new Date() }
        }
      }));
      recordActivity();
      showToast(lang === 'ru' ? 'Репутация изменена!' : 'Reputation updated!');
    } catch (error) {
      console.error('Voting error:', error);
      showToast(error.message, 'danger');
    } finally {
      setSubmittingRep(false);
      setRepTargetPost(null);
      setRepTargetPostNumber(null);
    }
  };

  const handleToggleSubscription = async () => {
    if (!user) return;
    setTogglingSub(true);
    try {
      const active = await toggleSubscription(id, user.uid);
      showToast(active ? t('notifications.followed_toast') : t('notifications.unfollowed_toast'));
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setTogglingSub(false);
    }
  };

  const handleMoveTopic = async (targetCategoryId) => {
    try {
      await moveTopics([id], targetCategoryId);
      showToast(lang === 'ru' ? 'Тема перенесена!' : 'Topic moved!');
      setShowMoveModal(false);
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const handleReply = async (e) => {
    e.preventDefault();
    if (!replyContent.trim() || submitting) return;

    recordActivity(); // posting = user is active
    setSubmitting(true);
    try {
      const postData = buildPostData();
      const newPostId = await createPost(postData);
      // Mark as read immediately (server-side)
      markTopicRead(id);
      setReplyContent('');
      
      // Calculate where the new post will be
      const newTotalPosts = posts.length + 1;
      const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE);
      
      if (targetPage !== currentPage) {
        setSearchParams({ page: targetPage });
      }

      setTimeout(() => {
        const element = document.getElementById(`post-${newPostId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('highlight-new-post');
          setTimeout(() => element.classList.remove('highlight-new-post'), 1000);
        }
      }, 500);

    } catch (err) {
      console.error(err);
      alert('Error posting reply');
    } finally {
      setSubmitting(false);
    }
  };

  // Build post data object for draft operations
  const buildPostData = () => {
    const selectedChar = characters.find(c => c.id === selectedCharacterId);
    return {
      topic_id: id,
      content: replyContent.trim(),
      author_id: user.uid,
      author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'),
      author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
      author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
      author_role_id: profile?.role_id || 'player',
      is_character: !!selectedChar,
      author_character_id: selectedCharacterId || null,
      author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
      owner_name: profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'
    };
  };

  const handleSaveDraft = async () => {
    if (!replyContent.trim() || hasDraft || draftSaving) return;
    setDraftSaving(true);
    try {
      await createDraftPost(buildPostData());
      setReplyContent('');
      showToast(t('forum.draft_saved'));
      // Navigate to last page so draft is visible
      const lastPage = Math.max(1, totalPages);
      if (currentPage !== lastPage) setSearchParams({ page: lastPage });
    } catch (err) {
      console.error(err);
      showToast(t('forum.draft_save_error'), 'danger');
    } finally {
      setDraftSaving(false);
    }
  };

  const handleUpdateDraft = async () => {
    if (!editContent.trim() || draftSaving) return;
    setDraftSaving(true);
    try {
      await updateDraftPost(user.uid, id, editContent.trim());
      setEditingPostId(null);
      setEditContent('');
      showToast(t('forum.draft_updated'));
    } catch (err) {
      console.error(err);
      showToast(t('forum.draft_update_error'), 'danger');
    } finally {
      setDraftSaving(false);
    }
  };

  const handlePublishDraft = async () => {
    if (topic?.is_locked && !hasPermission('moderate_content')) {
      showToast(t('forum.draft_locked_error'), 'danger');
      return;
    }
    setDraftSaving(true);
    recordActivity();
    try {
      await publishDraft(user.uid, id);
      markTopicRead(id);
      showToast(t('forum.draft_published'));
      // Go to last page where the published post will appear
      setTimeout(() => {
        const newTotal = posts.length + 1;
        const lastPage = Math.ceil(newTotal / ITEMS_PER_PAGE);
        setSearchParams({ page: lastPage, goLast: '1' });
      }, 400);
    } catch (err) {
      console.error(err);
      showToast(err.message || t('forum.draft_publish_error'), 'danger');
    } finally {
      setDraftSaving(false);
    }
  };

  const handleStartEdit = (post, isFirst = false) => {
    setEditingPostId(post.id);
    setEditContent(post.content);
    setEditingFirstPost(isFirst);
    if (isFirst && topic) {
      setEditTopicTitle(topic.title || '');
      setEditTopicDescription(topic.description || '');
    }
  };

  const handleSaveEdit = async (postId) => {
    if (!editContent.trim()) return;
    recordActivity();
    try {
      await updatePost(postId, editContent.trim(), {});
      if (editingFirstPost && topic) {
        await updateTopic(topic.id, {
          title: editTopicTitle.trim() || topic.title,
          description: editTopicDescription.trim()
        });
      }
      setEditingPostId(null);
      setEditContent('');
      setEditingFirstPost(false);
      setEditTopicTitle('');
      setEditTopicDescription('');
    } catch (err) {
      console.error(err);
      alert('Error editing post');
    }
  };

  const handleDeletePost = async () => {
    if (!deletingPost) return;
    
    try {
      if (deletingPost.is_draft) {
        await deleteDraftPost(user.uid, id);
      } else {
        const isOnlyPost = posts.length === 1;
        const categoryId = topic?.category_id;
        
        await deletePost(deletingPost);
        
        if (isOnlyPost) {
          // Topic was deleted because it was the last post
          if (categoryId) {
            navigate(`/category/${categoryId}`);
            return;
          } else {
            navigate('/');
            return;
          }
        }
      }
      setDeletingPost(null);
    } catch (err) {
      console.error(err);
      alert('Error deleting post');
    }
  };

  const canManagePost = (post) => {
    if (!user || profile?.status === 'pending') return false;
    return post.author_id === user.uid || hasPermission('moderate_content');
  };

  const getRoleBadge = (post) => {
    if (post.is_character) return null;
    
    // Check author data from stats
    const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];
    
    // If it's undefined, it's still loading (we explicitly set null for 'not found')
    if (authorData === undefined) {
      return <div className="skeleton skeleton-badge mb-2"></div>;
    }
    
    return (
      <ForumRoleBadge
        roleId={authorData?.role_id || post.author_role_id}
        status={authorData?.status}
        userEmail={authorData?.email}
        isDeleted={authorData === null}
        className="mb-2"
      />
    );
  };
    
  if (!topic || isPageLoading) {
    return (
      <Container className="py-4">
        <div className="mb-2">
          <Skeleton width={150} height="1rem" className="mb-2" />
        </div>
        
        <div className="mb-4">
          <div className="mb-2">
            <Skeleton width="40%" height="2.5rem" className="mb-2" />
            <Skeleton width="20%" height="1rem" />
          </div>
          
          <div className="d-flex justify-content-between align-items-end mt-3">
            <Skeleton width="30%" height="1rem" />
            <Skeleton width="100px" height="2.2rem" className="rounded-pill" />
          </div>
        </div>

        {[...Array(3)].map((_, i) => (
          <Card key={i} className="mb-4 post-card shadow-sm border-0 overflow-hidden">
            <Row className="g-0">
              <Col md={3} lg={2} className="author-sidebar p-3 d-none d-md-block text-center border-end" style={{ minHeight: '200px' }}>
                <Skeleton variant="avatar" width={80} height={80} className="mb-3 mx-auto rounded-circle" />
                <Skeleton width="70%" height="1.2rem" className="mb-2 mx-auto" />
                <Skeleton width="50%" height="0.8rem" className="mx-auto" />
              </Col>
              <Col md={9} lg={10} className="p-4">
                <div className="d-flex justify-content-between mb-4">
                  <Skeleton width="25%" height="1rem" />
                  <Skeleton width="40px" height="1rem" />
                </div>
                <div className="space-y-2">
                  <Skeleton width="100%" height="1rem" className="mb-2" />
                  <Skeleton width="100%" height="1rem" className="mb-2" />
                  <Skeleton width="85%" height="1rem" className="mb-2" />
                  <Skeleton width="40%" height="1rem" />
                </div>
                <div className="mt-5 pt-3 border-top">
                   <Skeleton width="120px" height="1.2rem" />
                </div>
              </Col>
            </Row>
          </Card>
        ))}
      </Container>
    );
  }

  if (category && !hasPermission(PERMISSIONS.VIEW_FORUM, { category })) {
    return (
      <Container className="py-5 text-center">
        <h3 className="text-muted">{lang === 'ru' ? 'Тема не найдена или доступ запрещён' : 'Topic not found or access denied'}</h3>
        <Button as={Link} to="/" variant="outline-primary" className="mt-3">
          {lang === 'ru' ? 'На главную' : 'Go Home'}
        </Button>
      </Container>
    );
  }

  const categoryTitle = category ? resolveText(category.title) : '...';
  const hasDraft = !!myDraft;

  // Pagination logic — since drafts are separate, posts only contains published posts
  const realPosts = posts;
  const totalPages = Math.ceil(realPosts.length / ITEMS_PER_PAGE);
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentPosts = realPosts.slice(indexOfFirstItem, indexOfLastItem);
  const isOnLastPage = currentPage >= totalPages || totalPages === 0;

  const handlePageChange = (page) => {
    setSearchParams({ page });
  };

  return (
    <Container className="py-4">
      <ForumBreadcrumbs 
        items={[
          ...(category ? [{ label: categoryTitle, to: `/category/${category.id}` }] : []),
          { label: topic?.title || '...', active: true }
        ]} 
      />

      <div className="mb-4 topic-header-area">
        <div className="mb-2">
          <div className="d-flex align-items-center gap-2 mb-1">
            {topic.is_pinned && <Pin size={20} className="topic-indicator topic-pinned" fill="currentColor" />}
            {topic.is_locked && <Lock size={20} className="topic-indicator topic-locked" />}
            <h1 className="h2 mb-0">{topic.title}</h1>
          </div>
          {topic.description && (
            <p className="text-muted mb-0 opacity-75 topic-description" style={{ fontSize: '0.875rem' }}>{topic.description}</p>
          )}
        </div>
        
        <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-end align-items-center gap-3">
          {/* Metadata Group */}
          <div className="d-flex align-items-center gap-2 flex-wrap flex-md-nowrap text-muted opacity-75 topic-meta-bar" style={{ fontSize: '0.875rem' }}>
            <span className="text-nowrap">
              {t('forum.author')}:{' '}
              <ForumAuthorName
                userId={topic.author_id}
                characterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                fallbackName={topic.author_name}
                className="fw-semibold text-primary"
              />
            </span>
            <span>·</span>
            <span className="text-nowrap">
              {lang === 'ru' ? 'Ответы' : 'Replies'}:{' '}
              <strong>{Math.max(0, (topic.posts_count || 1) - 1)}</strong>
            </span>
            <span>·</span>
            <span className="text-nowrap">{formatTime(topic.created_at)}</span>
          </div>

          {/* Actions & Pagination Group (Right Side) */}
          <div className="d-flex flex-column flex-md-row align-items-center gap-2 gap-md-3">
            {/* Admin Management Dropdown */}
            {(hasPermission(PERMISSIONS.MODERATE_CONTENT) || 
             hasPermission(PERMISSIONS.PIN_TOPICS) || 
             hasPermission(PERMISSIONS.CLOSE_TOPICS) || 
             hasPermission(PERMISSIONS.MOVE_TOPICS)) && (
              <Dropdown>
                <Dropdown.Toggle 
                  variant="link" 
                  size="sm" 
                  id="admin-topic-controls"
                  className="topic-manage-link d-flex align-items-center gap-1 text-decoration-none"
                >
                  <Settings size={14} />
                  <span>{t('forum.manage_topic')}</span>
                </Dropdown.Toggle>

                <Dropdown.Menu className="shadow-sm border-0">
                  {hasPermission(PERMISSIONS.PIN_TOPICS) && (
                  <Dropdown.Item 
                    onClick={async () => {
                      try {
                        await updateTopic(id, { is_pinned: !topic.is_pinned });
                        showToast(lang === 'ru' 
                          ? (topic.is_pinned ? 'Тема откреплена' : 'Тема закреплена') 
                          : (topic.is_pinned ? 'Topic unpinned' : 'Topic pinned')
                        );
                      } catch (error) {
                        showToast(error.message, 'danger');
                      }
                    }}
                    className="d-flex align-items-center gap-2"
                  >
                    <Pin size={14} />
                    {topic.is_pinned ? (lang === 'ru' ? 'Открепить' : 'Unpin') : (lang === 'ru' ? 'Закрепить' : 'Pin')}
                  </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.CLOSE_TOPICS) && (
                  <Dropdown.Item 
                    onClick={async () => {
                      try {
                        await updateTopic(id, { is_locked: !topic.is_locked });
                        showToast(lang === 'ru' 
                          ? (topic.is_locked ? 'Тема открыта' : 'Тема закрыта') 
                          : (topic.is_locked ? 'Topic unlocked' : 'Topic locked')
                        );
                      } catch (error) {
                        showToast(error.message, 'danger');
                      }
                    }}
                    className="d-flex align-items-center gap-2"
                  >
                    <Lock size={14} />
                    {topic.is_locked ? (lang === 'ru' ? 'Открыть' : 'Unlock') : (lang === 'ru' ? 'Закрыть' : 'Lock')}
                  </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.MOVE_TOPICS) && (
                  <Dropdown.Item 
                    onClick={() => setShowMoveModal(true)}
                    className="d-flex align-items-center gap-2"
                  >
                    <ArrowRightLeft size={14} />
                    {t('forum.move_topic')}
                  </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.MODERATE_CONTENT) && (
                  <>
                  <Dropdown.Divider />
                  <Dropdown.Item 
                    onClick={() => setShowDeleteTopicModal(true)}
                    className="d-flex align-items-center gap-2 text-danger"
                  >
                    <Trash2 size={14} />
                    {lang === 'ru' ? 'Удалить тему' : 'Delete Topic'}
                  </Dropdown.Item>
                  </>
                  )}
                </Dropdown.Menu>
              </Dropdown>
            )}

            {totalPages > 1 && (
              <ForumPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            )}
          </div>
        </div>
      </div>

      {/* Posts */}
      <div className="posts-container">
        {currentPosts.map((post, index) => (
          <Card key={post.id} id={`post-${post.id}`} className="mb-4 shadow-sm border-0 post-card">
            <Card.Body className="p-0">
              <Row className="g-0">
                {/* Author sidebar */}
                <Col md={3} lg={2} className="author-sidebar border-end px-2 pt-2 pb-0 text-center d-flex flex-column align-items-center">
                  {/* 1. Nickname */}
                  <div className="fw-bold text-center mb-1 text-truncate" style={{ maxWidth: '100%' }}>
                    <ForumAuthorName
                      userId={post.author_id}
                      characterId={post.author_character_id}
                      isCharacter={!!post.is_character}
                      fallbackName={post.author_name}
                      onClick={handleQuoteAuthor}
                    />
                  </div>

                  {/* 2. Status */}
                  {getLiveAuthorStatus(post) === 'LOADING' ? (
                    <div className="skeleton mb-2" style={{ width: '80%', height: '14px' }}></div>
                  ) : getLiveAuthorStatus(post) ? (
                    <div className="text-primary mb-2 text-truncate w-100 px-2" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                      {getLiveAuthorStatus(post)}
                    </div>
                  ) : null}

                  {/* 3. Avatar */}
                  <div className="mb-2">
                    <ForumAuthorAvatar
                      userId={post.author_id}
                      characterId={post.author_character_id}
                      isCharacter={!!post.is_character}
                      fallbackName={post.author_name}
                      initialAvatar={post.author_avatar}
                      size={120}
                      className="rounded shadow-sm"
                    />
                  </div>

                  {/* 4. Posts Count */}
                  <div className="text-muted mt-1 opacity-75" style={{ fontSize: '0.775rem' }}>
                    {t('profile.posts_count')}: {authorStats[post.author_id] !== undefined ? (
                      <strong>{authorStats[post.author_id]?.post_count || 0}</strong>
                    ) : (
                      <span className="skeleton ms-1" style={{ width: '25px', height: '14px' }}></span>
                    )}
                  </div>

                  {/* 5. Reputation */}
                  <div className="text-muted" style={{ fontSize: '0.775rem' }}>
                    {t('profile.reputation')}: {authorStats[post.author_id] !== undefined ? (
                      <strong>{authorStats[post.author_id]?.reputation || 0}</strong>
                    ) : (
                      <span className="skeleton ms-1" style={{ width: '25px', height: '14px' }}></span>
                    )}
                  </div>

                  {/* 6. Role/Mask */}
                  {!post.is_character && (
                    <div className="mt-2 mb-3 text-center w-100">{getRoleBadge(post)}</div>
                  )}
                  {post.is_character && (
                    <div className="text-muted mt-1 mb-3 opacity-75" style={{ fontSize: '0.875rem' }}>
                      {lang === 'ru' ? 'персонаж' : 'character'}
                      {getLiveOwnerName(post) && ` (${getLiveOwnerName(post)})`}
                    </div>
                  )}

                  {(() => {
                    const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];
                    if (!authorData) return null;
                    
                    return (
                      <div className="mt-auto py-2 border-top w-100 d-flex gap-3 justify-content-center border-top-dashed">
                        <Link to={`/profile/${post.author_id}`} className="footer-link text-decoration-none px-0">
                          {t('profile.view_profile')}
                        </Link>
                        {user && profile?.status !== 'pending' && profile?.role_id !== 'spectator' && authorData.status !== 'banned' && post.author_id !== user?.uid && (
                          <Link to={`/messages/${post.author_id}`} className="footer-link text-decoration-none px-0">
                            {t('profile.pm')}
                          </Link>
                        )}
                      </div>
                    );
                  })()}
                </Col>

                {/* Content Area */}
                <Col md={9} lg={10} className="d-flex flex-column" style={{ minHeight: '100%' }}>
                  {/* Header Strip: Time, # */}
                  <div className="post-header-strip px-2 px-md-4 py-1 d-flex justify-content-between align-items-center">
                    <small className="text-muted">
                      <a
                        href={`#post-${post.id}`}
                        className="text-decoration-none text-muted hover-link"
                        onClick={(e) => {
                          e.preventDefault();
                          const url = `${window.location.origin}${window.location.pathname}${window.location.search}#post-${post.id}`;
                          navigator.clipboard.writeText(url);
                          showToast(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
                          // Also navigate for classic behavior
                          window.location.hash = `post-${post.id}`;
                        }}
                      >
                        {formatTime(post.created_at)}
                      </a>
                      {post.edited_at && (
                        <span className="d-block d-md-inline-block ms-md-2 opacity-50">
                          ({lang === 'ru' ? 'ред.' : 'edited'} {formatTime(post.edited_at)})
                        </span>
                      )}
                    </small>
                    <div className="text-muted small opacity-50 post-number-indicator">#{index + indexOfFirstItem + 1}</div>
                  </div>

                  {/* Body Area */}
                  <div className="px-2 px-md-4 py-2 flex-grow-1 d-flex flex-column">
                    <div className="flex-grow-1">
                      {editingPostId === post.id ? (
                        <div>
                          {editingFirstPost && (
                            <div className="mb-3">
                              <Form.Group className="mb-2">
                                <Form.Label className="fw-semibold small">
                                  {lang === 'ru' ? 'Название темы' : 'Topic Title'}
                                </Form.Label>
                                <Form.Control
                                  type="text"
                                  value={editTopicTitle}
                                  onChange={e => setEditTopicTitle(e.target.value)}
                                  maxLength={100}
                                  required
                                />
                              </Form.Group>
                              <Form.Group>
                                <Form.Label className="fw-semibold small">
                                  {lang === 'ru' ? 'Описание темы' : 'Topic Description'}
                                </Form.Label>
                                <Form.Control
                                  type="text"
                                  value={editTopicDescription}
                                  onChange={e => setEditTopicDescription(e.target.value)}
                                  maxLength={200}
                                  placeholder={lang === 'ru' ? 'Краткое описание...' : 'Short description...'}
                                />
                              </Form.Group>
                            </div>
                          )}
                          <div className="mb-2">
                            <RichEditor
                              id="editContent"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              rows={6}
                              maxLength={MAX_CHARS}
                              autoFocus={true}
                              showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                              isEdit={true}
                            />
                          </div>
                          <div className="d-flex gap-2">
                            <Button size="sm" variant="primary" onClick={() => handleSaveEdit(post.id)}>
                              {lang === 'ru' ? 'Сохранить' : 'Save'}
                            </Button>
                            <Button size="sm" variant="outline-secondary" onClick={() => setEditingPostId(null)}>
                              {lang === 'ru' ? 'Отмена' : 'Cancel'}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="post-content">
                          <BBCode rolls={post.rolls}>{post.content}</BBCode>
                          {post.rolls && Object.keys(post.rolls).length > 0 && (
                            <div className="mt-2 small d-flex align-items-center gap-1" style={{ color: 'var(--secondary-color)' }}>
                              <Dices size={14} />
                              <span>{lang === 'ru' ? `Всего бросков: ${Object.keys(post.rolls).length}` : `Dice thrown: ${Object.keys(post.rolls).length}`}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Signature */}
                      {getLiveAuthorSignature(post) && (
                        <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                          <BBCode>{getLiveAuthorSignature(post)}</BBCode>
                        </div>
                      )}
                    </div>

                    {/* Reputation / Voting Buttons */}
                    {settings?.enableReputation && (post.author_id === user?.uid ? profile : authorStats[post.author_id]) !== null && (
                      <div className="mt-3 d-flex justify-content-end align-items-center gap-3 reputation-section">
                        <div
                          className={`text-muted small d-flex align-items-center gap-1 ${post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (post.author_id === user?.uid ? profile : authorStats[post.author_id])?.status !== 'banned' ? 'rep-trigger' : ''}`}
                          title={post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (post.author_id === user?.uid ? profile : authorStats[post.author_id])?.status !== 'banned'
                            ? (lang === 'ru' ? 'Репутация сообщения (Нажмите чтобы проголосовать или посмотреть детали)' : 'Post Reputation (Click to vote or view details)')
                            : (lang === 'ru' ? 'Репутация сообщения' : 'Post Reputation')}
                          onClick={() => {
                            const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];
                            if (post.author_id === profile?.uid || authorData?.status === 'banned') return;
                            
                            // If user has permission to use (vote), show modal or toggle controls
                            // If they DON'T have permission, they can still view details if they clicked an existing vote?
                            // Actually, let's stick to the rule: if no role perm, can only read (see counter).
                            if (!hasPermission(PERMISSIONS.USE_REPUTATION)) {
                              // Maybe allow viewing info if there are votes?
                              if (myVotes[post.id]) {
                                setSelectedVote(myVotes[post.id]);
                                setShowVoteInfoModal(true);
                              }
                              return;
                            }

                            if (myVotes[post.id]) {
                              setSelectedVote(myVotes[post.id]);
                              setShowVoteInfoModal(true);
                            } else {
                              setActiveRepPostId(activeRepPostId === post.id ? null : post.id);
                            }
                          }}
                        >
                          <Award size={14} className="text-accent" />
                          <strong>{post.reputation || 0}</strong>
                          {myVotes[post.id] && (
                            <span className="ms-1" style={{ fontWeight: 400, opacity: 0.8 }}>
                              ({myVotes[post.id].value > 0 ? '+1' : '-1'})
                            </span>
                          )}
                        </div>

                        {activeRepPostId === post.id && !myVotes[post.id] && post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (
                          <div className="reputation-controls d-flex align-items-center rounded px-2 py-1 gap-2 animate-fade-in shadow-sm">
                            <div className="d-flex gap-1">
                              <Button
                                size="sm"
                                variant="outline-danger"
                                className="py-0 px-2 voting-btn"
                                disabled={votingPostId === post.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenVoteModal(post, -1, index + indexOfFirstItem + 1);
                                }}
                              >
                                −
                              </Button>
                              <Button
                                size="sm"
                                variant="outline-success"
                                className="py-0 px-2 voting-btn"
                                disabled={votingPostId === post.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenVoteModal(post, 1, index + indexOfFirstItem + 1);
                                }}
                              >
                                +
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Post Management Links — only render if at least one button is visible */}
                  {user && profile?.status !== 'pending' && ((canManagePost(post) && (!topic.is_locked || hasPermission('moderate_content'))) ||
                    (profile?.role_id !== 'spectator' && (!topic.is_locked || hasPermission('moderate_content')))) && (
                    <div className="px-2 px-md-4 py-2 mt-auto d-flex justify-content-end gap-3 border-top border-top-dashed">
                      {canManagePost(post) && (!topic.is_locked || hasPermission('moderate_content')) && (
                        <>
                          <Button
                            variant="link"
                            size="sm"
                            className="footer-link p-0"
                            onClick={() => setDeletingPost(post)}
                          >
                            {lang === 'ru' ? 'Удалить' : 'Delete'}
                          </Button>
                          <Button
                            variant="link"
                            size="sm"
                            className="footer-link p-0"
                            onClick={() => handleStartEdit(post, (index + indexOfFirstItem) === 0)}
                          >
                            {lang === 'ru' ? 'Редактировать' : 'Edit'}
                          </Button>
                        </>
                      )}
                      {hasPermission(PERMISSIONS.POST_REPLY, { category }) && (!topic.is_locked || hasPermission('moderate_content')) && (
                        <Button
                          variant="link"
                          size="sm"
                          className="footer-link p-0"
                          onClick={() => {
                            const selectedText = window.getSelection().toString().trim();
                            const author = getLiveAuthorName(post) || 'User';
                            let content = selectedText || post.content;
                            
                            // Bake roll data into the content for "Static Quoting" permanence
                            if (post.rolls) {
                              content = content.replace(/\[roll=([a-z0-9_]+)\]/gi, (match, id) => {
                                const r = post.rolls[id];
                                if (r) {
                                  return `[roll=${id} value=${r.value} sides=${r.sides}${r.type ? ` type=${r.type}` : ''}]`;
                                }
                                return match;
                              });
                            }

                            const label = lang === 'ru' ? `[b]${author}[/b] написал(а):` : `[b]${author}[/b] wrote:`;

                            // BBCode Quote layout without extra trailing newlines to prevent gaps
                            const quote = `[quote]${label}\n${content}[/quote]\n`;

                            setReplyContent(prev => prev + quote);
                            // Clean selection after quoting
                            window.getSelection().removeAllRanges();
                            replyRef.current?.scrollIntoView({ behavior: 'smooth' });
                          }}
                        >
                          {lang === 'ru' ? 'Цитировать' : 'Quote'}
                        </Button>
                      )}
                    </div>
                  )}
                </Col>
              </Row>
            </Card.Body>
          </Card>
        ))}
      </div>

      {/* Draft Post — rendered after real posts, only on last page, only for author */}
      {myDraft && isOnLastPage && (
        <Card
          id={`post-${myDraft.id}`}
          className="mb-4 shadow-sm border-0 post-card draft-post-card"
        >
          <Card.Body className="p-0">
            <Row className="g-0">
              {/* Author sidebar */}
              <Col md={3} lg={2} className="author-sidebar border-end px-2 pt-2 pb-0 text-center d-flex flex-column align-items-center">
                <div className="fw-bold text-center mb-1 text-truncate" style={{ maxWidth: '100%' }}>
                  <ForumAuthorName
                    userId={myDraft.author_id}
                    characterId={myDraft.author_character_id}
                    isCharacter={!!myDraft.is_character}
                    fallbackName={myDraft.author_name}
                    onClick={handleQuoteAuthor}
                  />
                </div>
                {getLiveAuthorStatus(myDraft) && (
                  <div className="text-primary mb-2 text-truncate w-100 px-2" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                    {getLiveAuthorStatus(myDraft)}
                  </div>
                )}
                <div className="mb-2">
                  <ForumAuthorAvatar
                    userId={myDraft.author_id}
                    characterId={myDraft.author_character_id}
                    isCharacter={!!myDraft.is_character}
                    fallbackName={myDraft.author_name}
                    initialAvatar={myDraft.author_avatar}
                    size={120}
                    className="rounded shadow-sm"
                  />
                </div>
                <div className="text-muted mt-1" style={{ fontSize: '0.8rem' }}>
                  {t('profile.posts_count')}: <strong>{authorStats[myDraft.author_id]?.post_count || 0}</strong>
                </div>
                <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                  {t('profile.reputation')}: <strong>{authorStats[myDraft.author_id]?.reputation || 0}</strong>
                </div>
                {!myDraft.is_character && (
                  <div className="mt-2 mb-3 text-center w-100">{getRoleBadge(myDraft)}</div>
                )}
                {myDraft.is_character && (
                  <div className="text-muted mt-1 mb-3" style={{ fontSize: '0.875rem' }}>
                    {lang === 'ru' ? 'персонаж' : 'character'}
                    {getLiveOwnerName(myDraft) && ` (${getLiveOwnerName(myDraft)})`}
                  </div>
                )}
                {/* Draft Status Links */}
                <div className="mt-auto py-2 border-top w-100 d-flex gap-3 justify-content-center border-top-dashed">
                  <Link to={`/profile/${myDraft.author_id}`} className="footer-link text-decoration-none px-0">
                    {t('profile.view_profile')}
                  </Link>
                </div>
              </Col>

              {/* Content Area */}
              <Col md={9} lg={10} className="d-flex flex-column">
                {/* Header Strip — no date, no post number, just DRAFT badge */}
                <div className="post-header-strip px-2 px-md-4 py-1 d-flex justify-content-between align-items-center">
                  <Badge bg="secondary" style={{ letterSpacing: '0.05em', fontSize: '0.7rem' }}>
                    <FilePen size={11} className="me-1" />
                    {t('forum.draft_label')}
                  </Badge>
                  <span className="text-muted small fst-italic">
                    {t('forum.draft_only_you')}
                  </span>
                </div>

                {/* Body */}
                <div className="px-2 px-md-4 py-2 flex-grow-1 d-flex flex-column">
                  <div className="flex-grow-1">
                    {editingPostId === myDraft.id ? (
                      <div>
                        <div className="mb-2">
                          <RichEditor
                            id="draftEditContent"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            rows={6}
                            maxLength={MAX_CHARS}
                            autoFocus={true}
                            showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                            isEdit={true}
                          />
                        </div>
                        <div className="d-flex gap-2">
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            onClick={() => handleUpdateDraft(myDraft.id)}
                            disabled={draftSaving}
                          >
                            {draftSaving ? t('forum.draft_saving') : t('forum.draft_update_btn')}
                          </Button>
                          <Button size="sm" variant="outline-danger" onClick={() => { setEditingPostId(null); setEditContent(''); }}>
                            {t('common.cancel')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="post-content">
                        <BBCode rolls={myDraft.rolls}>{myDraft.content}</BBCode>
                      </div>
                    )}
                    {!editingPostId && getLiveAuthorSignature(myDraft) && (
                      <div className="mt-4 pt-3 border-top small text-muted post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                        <BBCode>{getLiveAuthorSignature(myDraft)}</BBCode>
                      </div>
                    )}
                  </div>
                </div>

                {/* Draft Management Links (Aligned with post footer) */}
                <div className="px-2 px-md-4 py-2 mt-auto d-flex justify-content-end gap-3 border-top border-top-dashed post-footer-links">
                  {/* Delete — allowed even on locked topics */}
                  {!editingPostId && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0"
                      onClick={() => setDeletingPost(myDraft)}
                    >
                      {t('common.delete')}
                    </Button>
                  )}
                  {/* Edit */}
                  {!editingPostId && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0"
                      onClick={() => handleStartEdit(myDraft, false)}
                    >
                      {t('common.edit')}
                    </Button>
                  )}
                  {/* Publish */}
                  {!editingPostId && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0 text-success fw-semibold"
                      onClick={() => handlePublishDraft(myDraft.id)}
                      disabled={draftSaving}
                    >
                      <Send size={12} className="me-1" />
                      {draftSaving ? t('forum.draft_publishing') : t('forum.draft_publish')}
                    </Button>
                  )}
                </div>
              </Col>
            </Row>
          </Card.Body>
        </Card>
      )}

      {/* Bottom Actions & Pagination */}
      <div className="mt-4 mb-4 px-2 px-md-0">
        {user && profile?.status === 'active' && profile?.role_id !== 'spectator' && (
          <div className="d-flex justify-content-end mb-3">
            <Button
              variant={isSubscribed ? "primary" : "outline-primary"}
              size="sm"
              className="d-flex align-items-center gap-2 rounded-pill px-3 shadow-sm"
              onClick={handleToggleSubscription}
              disabled={togglingSub}
            >
              {isSubscribed ? <BellOff size={14} /> : <Bell size={14} />}
              {isSubscribed ? t('notifications.unfollow') : t('notifications.follow')}
            </Button>
          </div>
        )}
        <div className="d-flex justify-content-center">
          <ForumPagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            centered
          />
        </div>
      </div>

      {/* Reply form — hidden for spectators and closed topics */}
      {
        !hasPermission(PERMISSIONS.POST_REPLY, { category }) ? (
          user && profile?.status === 'active' && (
            <div className="mt-5 p-4 text-center text-muted border rounded" ref={replyRef}>
              <span className="opacity-75">
                {t('forum.spectator_mode')}
              </span>
            </div>
          )
        ) : topic.posts_count >= 1000 ? (
          <div className="mt-5" ref={replyRef}>
            <Card className="shadow-sm border-0 bg-card overflow-hidden">
              <Card.Body className="p-4 text-center">
                <div className="d-flex flex-column align-items-center py-2">
                  <div className="bg-light rounded-circle p-3 mb-3" style={{ color: 'var(--role-banned)' }}>
                    <Lock size={32} />
                  </div>
                  <h4 className="fw-bold mb-2">
                    {lang === 'ru' ? 'Тема закрыта' : 'Topic Closed'}
                  </h4>
                  <p className="text-muted mb-0 mx-auto" style={{ maxWidth: '400px' }}>
                    {lang === 'ru' 
                      ? 'В теме достигнут лимит сообщений (1000/1000). Новые ответы более не принимаются.' 
                      : 'The message limit (1000/1000) has been reached for this topic. New replies are no longer accepted.'}
                  </p>
                </div>
              </Card.Body>
            </Card>
          </div>
        ) : topic.is_locked && !hasPermission('moderate_content') ? (
          <div className="mt-5 p-4 text-center text-muted rounded" style={{ backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)', opacity: 0.75 }} ref={replyRef}>
            <div className="mb-3">
              <MessageSquareOff size={48} className="opacity-25" />
            </div>
            <h5 className="mb-2">
              {t('forum.topic_locked')}
            </h5>
            <p className="small mb-0 opacity-75">
              {t('forum.topic_locked_desc')}
            </p>
          </div>
        ) : (
          <div className="mt-5" ref={replyRef}>
            <Card className="shadow-sm border-0 bg-card">
              <Card.Header className="bg-dark text-white py-3">
                <h5 className="mb-0">{t('forum.create_post')}</h5>
              </Card.Header>
              <Card.Body className="p-3 p-md-4">
                <Form onSubmit={handleReply}>
                  {hasPermission(PERMISSIONS.USE_MASKS, { category }) && (
                    <Form.Group className="mb-3" controlId="postAs">
                      <Dropdown className="mb-2 w-auto">
                        <Dropdown.Toggle 
                          variant="outline-management" 
                          className="d-flex align-items-center gap-2 custom-select-toggle"
                        >
                          <User size={16} />
                          <span className="text-truncate" style={{ maxWidth: '250px' }}>
                            {selectedCharacterId 
                              ? `${t('forum.post_as_character')}: ${characters.find(c => c.id === selectedCharacterId)?.name || '...'}`
                              : `${t('forum.post_as_user')}: ${profile?.nickname || profile?.email?.split('@')[0]}`
                            }
                          </span>
                        </Dropdown.Toggle>
                        <Dropdown.Menu className="shadow-sm border-0 custom-select-menu">
                          <Dropdown.Item 
                            active={selectedCharacterId === ''}
                            onClick={() => {
                              setSelectedCharacterId('');
                              if (user) updateUser(user.uid, { last_selected_character_id: '' });
                            }}
                          >
                            {t('forum.post_as_user')}: {profile?.nickname || profile?.email?.split('@')[0]}
                          </Dropdown.Item>
                          {characters.length > 0 && <Dropdown.Divider />}
                          {characters.map(char => (
                            <Dropdown.Item 
                              key={char.id}
                              active={selectedCharacterId === char.id}
                              onClick={() => {
                                setSelectedCharacterId(char.id);
                                if (user) updateUser(user.uid, { last_selected_character_id: char.id });
                              }}
                            >
                              {t('forum.post_as_character')}: {char.name}
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Menu>
                      </Dropdown>
                    </Form.Group>
                  )}
                  <Form.Group className="mb-3">
                    <RichEditor
                      id="reply-editor"
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder={t('forum.reply_placeholder')}
                      minHeight="150px"
                      maxLength={MAX_CHARS}
                      showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                      isEdit={false}
                    />
                  </Form.Group>

                  <div className="mt-4 d-flex justify-content-end gap-2">
                    {!hasDraft && (
                      <Button
                        variant="outline-secondary"
                        type="button"
                        disabled={submitting || draftSaving || !replyContent.trim()}
                        onClick={handleSaveDraft}
                      >
                        <FilePen size={14} className="me-1" />
                        {draftSaving ? t('forum.draft_saving') : t('forum.draft_save')}
                      </Button>
                    )}
                    <Button variant="primary" type="submit" className="px-4" disabled={submitting}>
                      {submitting
                        ? t('forum.posting')
                        : t('forum.create_post')}
                    </Button>
                  </div>
                </Form>
              </Card.Body>
            </Card>
          </div>
        )
      }

      <div className="mt-4">
        <ForumBreadcrumbs
          items={[
            ...(category ? [{ label: categoryTitle, to: `/category/${category.id}` }] : []),
            { label: topic?.title || '...', active: true }
          ]} 
        />

        <div className="d-flex justify-content-between">
          {category && (
            <Link to={`/category/${category.id}`} className="btn btn-outline-secondary">
              &larr; {t('forum.back_to_category')}
            </Link>
          )}
        </div>
      </div>

      {/* Modals */}
      <ConfirmModal
        show={!!deletingPost}
        onHide={() => setDeletingPost(null)}
        onConfirm={handleDeletePost}
        title={lang === 'ru' ? 'Удалить пост?' : 'Delete post?'}
        message={lang === 'ru'
          ? 'Это действие необратимо. Пост будет удалён навсегда.'
          : 'This action cannot be undone. The post will be permanently deleted.'}
        confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
        cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
      />

      <ConfirmModal
        show={showDeleteTopicModal}
        onHide={() => setShowDeleteTopicModal(false)}
        onConfirm={async () => {
          const catId = topic.category_id;
          await deleteTopics([id]);
          navigate(catId ? `/category/${catId}` : '/');
        }}
        title={lang === 'ru' ? 'Удалить тему целиком?' : 'Delete entire topic?'}
        message={lang === 'ru'
          ? 'Это действие удалит саму тему и все сообщения в ней навсегда. Вы уверены?'
          : 'This action will permanently delete the topic and all its posts. Are you sure?'}
        confirmText={lang === 'ru' ? 'Удалить полностью' : 'Delete permanently'}
        cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
      />

      {/* Move Topic Modal */}
      <MoveTopicsModal
        show={showMoveModal}
        onHide={() => setShowMoveModal(false)}
        onConfirm={handleMoveTopic}
        topicCount={1}
        excludeCategoryId={topic?.category_id}
      />

      <ForumModal
        show={showRepModal}
        onHide={() => setShowRepModal(false)}
        title={t('profile.rep_give')}
        footer={
          <>
            <Button variant="outline-secondary" onClick={() => setShowRepModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleRepVote} disabled={submittingRep}>
              {submittingRep ? t('common.loading') : t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="text-center mb-4">
          <Badge bg={repValue > 0 ? 'success' : 'danger'} className="fs-3 px-4 py-2">
            {repValue > 0 ? `+${repValue}` : repValue}
          </Badge>
          <div className="mt-3 text-muted small px-3">
            {lang === 'ru'
              ? 'Этот голос изменит репутацию данного поста и будет зачислен в общую репутацию (карму) автора.'
              : 'This vote will change the reputation of this post and contribute to the author\'s total reputation (karma).'}
          </div>
        </div>
        <Form.Group>
          <Form.Label className="fw-bold small">{lang === 'ru' ? 'Комментарий (опционально)' : 'Leave a comment (optional)'}</Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={repComment}
            onChange={(e) => setRepComment(e.target.value)}
            placeholder=""
            className="modal-section-themed"
          />
        </Form.Group>
      </ForumModal>

      <ForumModal
        show={showVoteInfoModal}
        onHide={() => setShowVoteInfoModal(false)}
        title={lang === 'ru' ? 'Информация о вашем голосе' : 'Your Vote Information'}
        className="premium-modal shadow-lg"
        footer={
          <Button variant="outline-secondary" className="w-100" onClick={() => setShowVoteInfoModal(false)}>
            {t('common.close')}
          </Button>
        }
      >
        {selectedVote && (
          <div className="d-flex flex-column gap-3">
            <div className="d-flex justify-content-between align-items-center modal-inner-card p-3">
              <div>
                <div className="small text-muted">{lang === 'ru' ? 'Ваш голос' : 'Your vote'}</div>
                <Badge bg={selectedVote.value > 0 ? 'success' : 'danger'} className="fs-5 mt-1">
                  {selectedVote.value > 0 ? `+${selectedVote.value}` : selectedVote.value}
                </Badge>
              </div>
              <div className="text-end">
                <div className="small text-muted">{lang === 'ru' ? 'Дата' : 'Date'}</div>
                <div className="fw-bold">{formatTime(selectedVote.created_at)}</div>
              </div>
            </div>

            <div>
              <div className="small text-muted mb-2">{lang === 'ru' ? 'Ваш комментарий' : 'Your comment'}</div>
              <div className="p-3 modal-inner-card border-start border-4 border-accent" style={{ minHeight: '60px' }}>
                {selectedVote.comment || (lang === 'ru' ? <span className="opacity-50 italic">Без комментария</span> : <span className="opacity-50 italic">No comment left</span>)}
              </div>
            </div>

            <div className="small text-muted opacity-75 italic text-center mt-2">
              {lang === 'ru'
                ? 'Этот голос зачислен автору поста.'
                : 'This vote has been contributed to the post author.'}
            </div>
          </div>
        )}
      </ForumModal>

    </Container>
  );
};

export default TopicPage;
