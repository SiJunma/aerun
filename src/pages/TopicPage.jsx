import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Container, Card, Row, Col, Image, Badge, Button, Form, Modal, Pagination, Dropdown } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import {
  fetchSecuredPosts, createPost, updatePost, deletePost, subscribeToTopic,
  updateUser, updateTopic,
  deleteTopics, moveTopics, movePosts, createDraftPost, updateDraftPost, publishDraft,
  subscribeToTopicDraft, deleteDraftPost, locatePost, locateUnreadPost
} from '../api/forum';

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { subscribeToCharacters } from '../api/character';
import { fetchUnreadTopicNotifications } from '../api/notifications';

import ConfirmModal from '../components/common/ConfirmModal';
import ForumModal from '../components/common/ForumModal';
import MoveTopicsModal from '../components/modals/MoveTopicsModal';
import MovePostsModal from '../components/modals/MovePostsModal';
import RichEditor from '../components/common/RichEditor';
import BBCode from '../components/common/BBCode';
import Timestamp from '../components/common/Timestamp';
import {
  Award, Pin, Lock, Settings, Trash2, ArrowRightLeft, Bell, BellOff, MessageSquare, Send,
  Search, Filter, ChevronUp, ChevronDown, Heart, Flag, Share2, MoreHorizontal,
  Dices, User, FilePen, MessageSquareOff, Keyboard
} from 'lucide-react';
import { subscribeToUserNotifications, markNotificationRead, clearOrphanedPostNotifications } from '../api/notifications';
import { voteOnPost, getVotesInTopic, updateReputationComment } from '../api/reputation';
import ReputationHoverPreview from '../components/common/ReputationHoverPreview';
import { subscribeToTopicStatus, toggleSubscription } from '../api/subscriptions';
import ForumPagination from '../components/common/ForumPagination';
import { resolveField } from '../utils/text';
import ForumAuthorName from '../components/common/ForumAuthorName';
import ForumAuthorAvatar from '../components/common/ForumAuthorAvatar';
import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import ForumRoleBadge from '../components/common/ForumRoleBadge';
import ForumCharacterBadge from '../components/common/ForumCharacterBadge';
import Skeleton from '../components/common/Skeleton';
import { useToast } from '../contexts/ToastProvider';
import { usePageTitle } from '../contexts/TitleProvider';

const TopicPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { t, lang } = useI18n();
  const { profile, setProfile, user, recordActivity, markTopicRead, updateLocalTopicLastPost, refreshForumState, readMap, hasPermission, PERMISSIONS, settings, categories, isUserOnline } = useAuth();
  const { showToast } = useToast();
  const { setPageTitle } = usePageTitle();
  const [searchParams, setSearchParams] = useSearchParams();
  const [replyContent, setReplyContent] = useState('');
  const [guestNickname, setGuestNickname] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [topic, setTopic] = useState(null);
  const [category, setCategory] = useState(null);
  const [posts, setPosts] = useState([]);
  const [pinnedFirstPost, setPinnedFirstPost] = useState(null);
  const [myDraft, setMyDraft] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [authorStats, setAuthorStats] = useState({}); // { uid: { post_count: N } }
  const [maskStats, setMaskStats] = useState({}); // { charId: { status_line: '' } }

  // Edit state
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [editCharacterId, setEditCharacterId] = useState('');
  // Extra fields when editing the first post (topic title/description)
  const [editTopicTitle, setEditTopicTitle] = useState('');
  const [editTopicDescription, setEditTopicDescription] = useState('');
  const [editPinFirstPost, setEditPinFirstPost] = useState(false);
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
  const [isEditingRepComment, setIsEditingRepComment] = useState(false);
  const [editingRepComment, setEditingRepComment] = useState('');
  const [savingRepComment, setSavingRepComment] = useState(false);

  // Subscription state
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [togglingSub, setTogglingSub] = useState(false);
  const [unreadQuotes, setUnreadQuotes] = useState([]);

  // Move Topic / Move Posts state
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showMovePostsModal, setShowMovePostsModal] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(true);

  const replyRef = useRef(null);
  const replyEditorRef = useRef(null);
  const draftEditorRef = useRef(null);
  const editEditorRef = useRef(null);
  const goLast = searchParams.get('goLast') === '1';
  const isJumpRequested = !!(searchParams.get('post') || goLast || hash.startsWith('#post-'));
  const ITEMS_PER_PAGE = settings?.postsPerPage ?? 20;
  const MAX_CHARS = settings?.maxCharsPerPost ?? 15000;
  const computedMaxChars = MAX_CHARS > 0 ? MAX_CHARS : undefined;

  const currentPage = parseInt(searchParams.get('page') || '1', 10);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  const profileRef = useRef(profile);
  profileRef.current = profile;

  const readMapRef = useRef(readMap);
  readMapRef.current = readMap;

  const topicRef = useRef(topic);
  topicRef.current = topic;

  const isFetchingPostsRef = useRef(false);
  const prevTopicStatsRef = useRef(null);

  const [accessError, setAccessError] = React.useState(null);

  const loadPosts = React.useCallback(async (overridePage) => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasPageParam = urlParams.has('page');
    const isGoLast = urlParams.get('goLast') === '1';

    let pageToFetch = overridePage !== undefined ? overridePage : currentPageRef.current;
    let lastVisitMs = null;

    if (overridePage === undefined && isGoLast && !hasPageParam) {
      pageToFetch = 'last';
      const lastVisitRaw = initialVisitRef.current[id] ?? readMapRef.current[id];
      const regMs = profileRef.current?.created_at?.toMillis?.() || 0;
      const lastVisitVal = lastVisitRaw?.timestamp || lastVisitRaw;
      const rawMs = lastVisitVal?.toMillis ? lastVisitVal.toMillis() : (typeof lastVisitVal === 'number' ? lastVisitVal : 0);
      lastVisitMs = Math.max(rawMs, regMs) || null;
    }

    if (isFetchingPostsRef.current === pageToFetch) {
      return [];
    }
    isFetchingPostsRef.current = pageToFetch;
    try {
      const { posts: data, pinnedPost, page: resolvedPage, lastPost } = await fetchSecuredPosts(id, pageToFetch, ITEMS_PER_PAGE, lastVisitMs);

      if (lastPost && topicRef.current) {
        updateLocalTopicLastPost(id, topicRef.current.category_id, topicRef.current.title, lastPost, topicRef.current.posts_count);
      }

      if (resolvedPage && pageToFetch === 'last') {
        jumpTargetPageRef.current = resolvedPage;
        const currentUrlParams = new URLSearchParams(window.location.search);
        if (currentUrlParams.get('page') !== resolvedPage.toString()) {
          currentUrlParams.set('page', resolvedPage.toString());
          window.history.replaceState(null, '', `${window.location.pathname}?${currentUrlParams.toString()}`);
        }
      }

      const activePage = resolvedPage || pageToFetch;
      if (currentPageRef.current === activePage || pageToFetch === 'last') {
        const curTopic = topicRef.current;
        if (data.length === 0 && activePage > 1 && curTopic) {
          const validMaxPage = Math.max(1, Math.ceil((curTopic.posts_count || 1) / ITEMS_PER_PAGE));
          if (activePage > validMaxPage) {
            const p = new URLSearchParams(window.location.search);
            p.set('page', validMaxPage.toString());
            window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
            return [];
          }
        }
        setPosts(data);
        setPinnedFirstPost(pinnedPost || null);
        setAuthorStats(prev => {
          const next = { ...prev };
          data.forEach(p => {
            if (p.author_id) {
              const serverPostCount = p.author_posts_count ?? 0;
              const cachedPostCount = next[p.author_id]?.post_count ?? 0;
              // For the current user: server may return stale post_count because
              // onPostCreated trigger hasn't run yet — keep the higher (optimistic) value.
              const postCount = p.author_id === user?.uid
                ? Math.max(serverPostCount, cachedPostCount)
                : serverPostCount || cachedPostCount;
              next[p.author_id] = {
                ...(next[p.author_id] || {}),
                post_count: postCount,
                reputation: p.author_reputation ?? next[p.author_id]?.reputation ?? 0
              };
            }
          });
          return next;
        });
      }
      return data;
    } catch (err) {
      console.error(err);
      if (err?.message?.includes('permission') || err?.message?.includes('403') || err?.code === 'permission-denied') {
        setAccessError(err.message || 'Access denied');
        setIsPageLoading(false);
      }
      return [];
    } finally {
      if (isFetchingPostsRef.current === pageToFetch) {
        isFetchingPostsRef.current = false;
      }
    }
  }, [id, ITEMS_PER_PAGE]);

  useEffect(() => {
    if (topic && prevTopicStatsRef.current) {
      const prev = prevTopicStatsRef.current;
      if (prev.id === topic.id) {
        if (prev.posts_count !== topic.posts_count || prev.last_post_at !== topic.last_post_at) {
          const maxPage = Math.max(1, Math.ceil((topic.posts_count || 1) / ITEMS_PER_PAGE));
          if (currentPageRef.current === maxPage) {
            loadPosts();
          }
        }
      }
    }
    if (topic) {
      prevTopicStatsRef.current = {
        id: topic.id,
        posts_count: topic.posts_count,
        last_post_at: topic.last_post_at
      };
      setPageTitle(topic.title);
    }
  }, [topic?.id, topic?.posts_count, topic?.last_post_at, loadPosts, setPageTitle, ITEMS_PER_PAGE]);

  const currentTopicIdRef = useRef(id);
  const jumpTargetPageRef = useRef(null);

  useEffect(() => {
    // Reset loading state and clear posts before loading the new page
    setIsPageLoading(true);
    setPosts([]);
    setTimeout(() => {
      loadPosts();
    }, 0);

    // Only clear topic if navigating to a DIFFERENT topic
    if (currentTopicIdRef.current !== id) {
      setTopic(null);
      currentTopicIdRef.current = id;
    }
    
    let topicReady = topic !== null;
    let postsReady = false;

    const checkReady = () => {
      if (topicReady && postsReady) {
        if (!isJumpRequested || alreadyJumpedRef.current) {
          setIsPageLoading(false);
        }
      }
    };

    const unsubTopic = subscribeToTopic(id, (data, err) => {
      if (err) {
        setAccessError(err.message || 'Access denied');
        setIsPageLoading(false);
        return;
      }
      setTopic(data);
      if (data) {
        topicReady = true;
        checkReady();
      }
    });

    return () => {
      unsubTopic();
    };
  }, [id, currentPage]);

  // Mark the topic as read with granular offset
  useEffect(() => {
    if (user && id && posts.length > 0 && profile?.role_id !== 'spectator') {
      // Calculate the global index of the last message currently visible on this page
      // Mark everything on the current page as read
      const lastMessageIndex = (currentPage - 1) * ITEMS_PER_PAGE + posts.length - 1;
      markTopicRead(id, lastMessageIndex);
    }
  }, [posts.length, id, user, markTopicRead, currentPage, profile?.role_id, ITEMS_PER_PAGE]);

  // Subscribe to draft
  useEffect(() => {
    if (!user || !id) return;
    const unsub = subscribeToTopicDraft(id, user.uid, setMyDraft);
    return () => unsub();
  }, [user, id]);

  // Track unread quote and mention notifications and clear them via IntersectionObserver
  useEffect(() => {
    if (!user || !id) return;
    const unsub = subscribeToUserNotifications(user.uid, (notifs) => {
      const activeQuotes = notifs.filter(n =>
        !n.read &&
        n.payload?.topic_id === id &&
        (n.type === 'post_quoted' || n.type === 'post_mentioned' || n.type === 'POST_MENTIONED')
      );
      setUnreadQuotes(activeQuotes);
    });
    return () => unsub();
  }, [user, id]);

  useEffect(() => {
    if (unreadQuotes.length === 0 || posts.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const postId = entry.target.id.replace('post-', '');
          const matchingNotifs = unreadQuotes.filter(n => n.payload?.post_id === postId);

          if (matchingNotifs.length > 0) {
            matchingNotifs.forEach(n => markNotificationRead(n.id));
            setUnreadQuotes(prev => prev.filter(p => !matchingNotifs.some(m => m.id === p.id)));
          }
        }
      });
    }, { threshold: 0.1 });

    unreadQuotes.forEach(n => {
      if (n.payload?.post_id) {
        const node = document.getElementById(`post-${n.payload.post_id}`);
        if (node) observer.observe(node);
      }
    });

    return () => observer.disconnect();
  }, [unreadQuotes, posts]);

  // Subscribe to characters separately so we can unsubscribe properly
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToCharacters(user.uid, setCharacters);

    // Fetch my votes in this topic
    getVotesInTopic(user.uid, id).then(setMyVotes).catch(console.error);

    return () => unsub();
  }, [user, id]);

  useEffect(() => {
    if (!user || !id || profile?.role_id === 'pending') return;
    const unsub = subscribeToTopicStatus(id, user.uid, setIsSubscribed);
    return () => unsub();
  }, [user, id, profile?.role_id]);

  // Set initial selectedCharacterId from profile
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.last_selected_character_id]);

  useEffect(() => {
    if (topic?.category_id) {
      const found = categories.find(c => c.id === topic.category_id);
      if (found) setCategory(found);
    }
  }, [topic?.category_id, categories]);

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

  // authorStats are populated from getSecuredPosts server hydration (author_posts_count, author_reputation)
  // No extra Firestore reads needed per author

  // Subscribe to character masks
  useEffect(() => {
  if (posts.length === 0) return;
    const characterMasks = posts.filter(p => p.is_character && p.author_character_id);

    characterMasks.forEach(async (p) => {
      const { author_id: uid, author_character_id: charId } = p;
      if (!uid || !charId || maskStats[charId] !== undefined) return;

      try {
        const charSnap = await getDoc(doc(db, 'users', uid, 'characters', charId));
        setMaskStats(prev => ({
          ...prev,
          [charId]: charSnap.exists() ? { id: charSnap.id, ...charSnap.data() } : null
        }));
      } catch (err) {
        console.error('[fetchCharacter error]', err);
      }
    });
  }, [posts]);



  // ── Unified Navigation & Scroll Controller ────────────────────────────────
  const lastTargetRef = useRef('');
  const initialVisitRef = useRef({}); // { topicId: timestamp } - capture when user arrives
  const alreadyJumpedRef = useRef(false);
  const { key: locationKey } = useLocation();

  // Reset jump flag when navigating to a DIFFERENT topic or clicking a new link
  useEffect(() => {
    alreadyJumpedRef.current = false;
  }, [id, locationKey]);

  // Reset jumpTargetPageRef ONLY when the topic changes, so we don't clear it during our own redirects
  useEffect(() => {
    jumpTargetPageRef.current = null;
  }, [id]);

  // Capture initial visit state once per topic change
  useEffect(() => {
    if (user && id && readMap[id] !== undefined && initialVisitRef.current[id] === undefined) {
      initialVisitRef.current[id] = readMap[id];
    }
  }, [user, id, readMap]);

  useEffect(() => {
    // 1. Topics not yet loaded
    if (!topic) {
      return;
    }

    // If posts are not loaded, we can only proceed if a jump is requested (to resolve the page)
    const isJumpRequestedLocal = !!(searchParams.get('post') || goLast || hash.startsWith('#post-'));
    if (posts.length === 0 && !isJumpRequestedLocal) {
      return;
    }

    let targetId = null;
    let targetPage = currentPage;
    let scrollBlock = 'start';

    // Priority 1: ?post=ID (Clicking from a quote)
    const queryPostId = searchParams.get('post');
    if (queryPostId) {
      const postIndex = posts.findIndex(p => p.id === queryPostId);
      if (postIndex !== -1) {
        targetPage = currentPage;
        targetId = `post-${queryPostId}`;
        scrollBlock = 'center';
      } else if (jumpTargetPageRef.current !== currentPage) {
        // Post not found on the current page - try to locate it across the database
        locatePost(queryPostId, ITEMS_PER_PAGE).then(result => {
          if (result.found) {
            if (result.topicId === id) {
              if (result.page !== currentPage) {
                jumpTargetPageRef.current = result.page;
                alreadyJumpedRef.current = false;
                setSearchParams({ page: result.page, post: queryPostId }, { preventScrollReset: true });
              } else {
                jumpTargetPageRef.current = currentPage;
                loadPosts();
              }
            } else {
              navigate(`/topic/${result.topicId}?post=${queryPostId}`);
            }
          } else {
            if (user?.uid) {
              clearOrphanedPostNotifications(user.uid, queryPostId).catch(err => console.error('[Cleanup Orphaned Notification error]', err));
            }
            setIsPageLoading(false);
            alreadyJumpedRef.current = true;

            setSearchParams(prev => {
              const params = new URLSearchParams(prev);
              params.delete('post');
              return params;
            }, { replace: true, preventScrollReset: true });

            setTimeout(() => {
              showToast(lang === 'ru' ? 'Исходное сообщение было удалено' : 'The original post was deleted', 'warning');
            }, 500);
          }
        }).catch(err => {
          console.error('[TopicPage navigation locator error]', err);
          setIsPageLoading(false);
          alreadyJumpedRef.current = true;
        });
        return;
      } else if (posts.length > 0) {
         // Post was not found even after ensuring current page loaded. Probably deleted.
         alreadyJumpedRef.current = true;
         setIsPageLoading(false);
      }
    }
    // Priority 2: #post-ID (Legacy anchors)
    else if (hash && hash.startsWith('#post-')) {
      const postId = hash.replace('#post-', '');
      const postIndex = posts.findIndex(p => p.id === postId);
      if (postIndex !== -1) {
        targetPage = currentPage;
        targetId = hash.substring(1);
      } else if (jumpTargetPageRef.current !== currentPage) {
        locatePost(postId, ITEMS_PER_PAGE).then(result => {
           if (result.found && result.topicId === id) {
              if (result.page !== currentPage) {
                 jumpTargetPageRef.current = result.page;
                 alreadyJumpedRef.current = false;
                 setSearchParams({ page: result.page }, { preventScrollReset: true });
                 // hash stays in window.location.hash natively
              } else {
                 jumpTargetPageRef.current = currentPage;
                 loadPosts();
              }
           } else {
              setIsPageLoading(false);
              alreadyJumpedRef.current = true;
           }
        }).catch(() => {
           setIsPageLoading(false);
           alreadyJumpedRef.current = true;
        });
        return;
      } else if (posts.length > 0) {
        alreadyJumpedRef.current = true;
        setIsPageLoading(false);
      }
    }
    // Priority 3: goLast (New unread or bottom)
    else if (goLast && !alreadyJumpedRef.current) {
      if (user && (initialVisitRef.current[id] !== undefined || readMap[id] !== undefined)) {
        const lastVisitRaw = initialVisitRef.current[id] ?? readMap[id];
        const registrationMs = profile?.created_at?.toMillis?.() || 0;
        const lastVisitValue = lastVisitRaw?.timestamp || lastVisitRaw;
        const lastVisit = Math.max(
          lastVisitValue?.toMillis ? lastVisitValue.toMillis() : (lastVisitValue || 0),
          registrationMs
        );

        const unreadIndex = posts.findIndex(p => (p.created_at?.toMillis?.() || 0) > lastVisit);

        if (unreadIndex !== -1) {
          targetId = `post-${posts[unreadIndex].id}`;
        } else if (posts.length > 0) {
          // All posts read or on last page: target the last post on screen
          targetId = `post-${posts[posts.length - 1].id}`;
        }
      } else {
        const finalTargetPage = Math.ceil((topic?.posts_count || 1) / ITEMS_PER_PAGE) || 1;
        if (currentPage !== finalTargetPage) {
          jumpTargetPageRef.current = finalTargetPage;
          setSearchParams({ page: finalTargetPage, goLast: '1' }, { preventScrollReset: true });
          return;
        }
        targetId = posts.length > 0 ? `post-${posts[posts.length - 1].id}` : null;
      }
    }

    // 2. Perform the actual scroll
    const fullTargetKey = `${id}_${targetPage}_${targetId}_${queryPostId || ''}_${locationKey}`;
    if (targetId && lastTargetRef.current !== fullTargetKey) {
      lastTargetRef.current = fullTargetKey;

      let scrollAttempts = 0;
      const MAX_ATTEMPTS = 50;

      const tryScroll = () => {
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: scrollBlock });
          el.classList.add('highlight-new-post');
          setTimeout(() => el.classList.remove('highlight-new-post'), 2000);
          if (goLast || searchParams.get('post')) {
            alreadyJumpedRef.current = true;
          }
          setIsPageLoading(false);
        } else {
          scrollAttempts++;
          if (scrollAttempts < MAX_ATTEMPTS) {
            setTimeout(tryScroll, 100);
          } else {
            setIsPageLoading(false);
            alreadyJumpedRef.current = true;
          }
        }
      };

      setTimeout(tryScroll, 100);
    } else {
      if (isJumpRequested || searchParams.get('post') || goLast) {
        if (posts.length > 0 || !isFetchingPostsRef.current) {
          setIsPageLoading(false);
          alreadyJumpedRef.current = true;
        }
      } else if (posts.length > 0 || !isFetchingPostsRef.current) {
        setIsPageLoading(false);
      }
    }
  }, [posts, topic, searchParams, goLast, currentPage, hash, id, readMap, profile, navigate, setSearchParams, user, locationKey, isJumpRequested, lang, showToast, ITEMS_PER_PAGE]);
  const getLiveOwnerName = (post) => {
    if (post.author_id === user?.uid) {
      return profile?.nickname || post.owner_name;
    }
    return authorStats[post.author_id]?.nickname || post.owner_name;
  };

  const handleQuoteAuthor = (authorName) => {
    if (!hasPermission(PERMISSIONS.POST_REPLY, { category })) return;

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
    if (!post.author_id) return '';
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

  const isAuthorOnline = (post) => {
    if (!post?.author_id) return false;
    // Own posts: current user is always online while viewing
    if (post.author_id === user?.uid) return true;
    return isUserOnline(post.author_id);
  };


  // Formatting and Helpers



  const handleOpenVoteModal = (post, value, postNumber) => {
    if (!user || profile?.role_id === 'spectator') return;
    if (!post.author_id || post.author_id === user.uid) return;
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
      
      // Optimistic update for posts
      setPosts(prev => prev.map(p => 
        p.id === repTargetPost.id 
          ? { ...p, reputation: (p.reputation || 0) + repValue } 
          : p
      ));

      // Optimistic update for first post if it's the target
      setTopic(prev => {
        if (prev?.first_post?.id === repTargetPost.id) {
          return {
            ...prev,
            first_post: {
              ...prev.first_post,
              reputation: (prev.first_post.reputation || 0) + repValue
            }
          };
        }
        return prev;
      });

      // Optimistic update for authorStats
      setAuthorStats(prev => {
        if (!repTargetPost.author_id || !(repTargetPost.author_id in prev)) return prev;
        const stats = prev[repTargetPost.author_id];
        if (!stats) return prev;
        return {
          ...prev,
          [repTargetPost.author_id]: {
            ...stats,
            reputation: (stats.reputation || 0) + repValue
          }
        };
      });

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

  const handleUpdateRepComment = async () => {
    if (!selectedVote || !user) return;
    setSavingRepComment(true);
    try {
      await updateReputationComment(selectedVote.id, editingRepComment);

      const updatedVote = { ...selectedVote, comment: editingRepComment };
      setSelectedVote(updatedVote);
      setMyVotes(prev => ({
        ...prev,
        [selectedVote.post_id]: updatedVote
      }));

      setIsEditingRepComment(false);
      showToast(lang === 'ru' ? 'Комментарий к репутации обновлен' : 'Reputation comment updated');
    } catch (err) {
      console.error(err);
      showToast(err.message, 'danger');
    } finally {
      setSavingRepComment(false);
    }
  };

  const handleToggleSubscription = async () => {
    if (!user) return;
    setTogglingSub(true);
    try {
      const active = await toggleSubscription(id, user.uid);
      setIsSubscribed(active);
      showToast(active ? t('notifications.followed_toast') : t('notifications.unfollowed_toast'));
    } catch (err) {
      showToast(err.message, 'danger');
    } finally {
      setTogglingSub(false);
    }
  };

  const handleMoveTopic = async (targetCategoryId) => {
    try {
      await moveTopics([id], targetCategoryId, user.uid);
      showToast(lang === 'ru' ? 'Тема перенесена!' : 'Topic moved!');
      setShowMoveModal(false);
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      showToast(err.message, 'danger');
    }
  };

  const handleMovePosts = async (postIds, targetTopicId) => {
    try {
      const isFirstPostMoved = posts.length > 0 && postIds.includes(posts[0].id);
      const categoryId = topic?.category_id;

      await movePosts(postIds, targetTopicId, user.uid);
      showToast(t('forum.move_posts_success'));

      if (isFirstPostMoved) {
        if (categoryId) {
          navigate(`/category/${categoryId}`);
        } else {
          navigate('/');
        }
      } else {
        await loadPosts();
      }
    } catch (err) {
      showToast(err.message, 'danger');
      throw err; // let the modal keep submitting=false
    }
  };

  const handleReply = async (e) => {
    e?.preventDefault?.();
    if (submitting) return;

    if (!replyContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }

    if (!user && !guestNickname.trim()) {
      showToast(lang === 'ru' ? 'Введите ваш никнейм' : 'Please enter your nickname', 'danger');
      return;
    }

    recordActivity(); // posting = user is active
    setSubmitting(true);
    try {
      const postData = buildPostData();
      const newPostId = await createPost(postData);
      // Client-side post count updates
      if (user?.uid) {
        setProfile(prev => prev ? { ...prev, post_count: (prev.post_count || 0) + 1 } : prev);
        setAuthorStats(prev => ({
          ...prev,
          [user.uid]: {
            ...(prev[user.uid] || {}),
            post_count: ((prev[user.uid]?.post_count) || 0) + 1
          }
        }));
      }
      // Mark as read immediately (server-side)
      markTopicRead(id);
      setReplyContent('');

      // Calculate where the new post will land.
      const postsBeforeNew = (currentPage - 1) * ITEMS_PER_PAGE + posts.length;
      const newTotalPosts = postsBeforeNew + 1;
      const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

      // Immediately update local topic state so posts_count and pagination UI update instantly
      setTopic(prev => prev ? {
        ...prev,
        posts_count: Math.max(newTotalPosts, (prev.posts_count || 0) + 1),
        last_post_at: new Date().toISOString()
      } : prev);

      if (prevTopicStatsRef.current) {
        prevTopicStatsRef.current.posts_count = Math.max(newTotalPosts, (prevTopicStatsRef.current.posts_count || 0) + 1);
        prevTopicStatsRef.current.last_post_at = new Date().toISOString();
      }

      if (targetPage !== currentPage) {
        alreadyJumpedRef.current = false;
        setSearchParams({ page: targetPage, post: newPostId }, { preventScrollReset: true });
      } else {
        // Already on the correct page — reload posts and scroll
        await loadPosts(currentPage);
        setTimeout(() => {
          const element = document.getElementById(`post-${newPostId}`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-new-post');
            setTimeout(() => element.classList.remove('highlight-new-post'), 1000);
          }
        }, 300);
      }

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
      category_id: topic?.category_id,
      content: replyContent.trim(),
      author_id: user?.uid || null,
      author_name: selectedChar ? selectedChar.name : (profile?.nickname || guestNickname.trim() || user?.displayName || profile?.email?.split('@')[0] || 'Guest'),
      author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
      author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
      author_role_id: profile?.role_id || 'spectator', // guests take base role or 'spectator' depending on context
      is_character: !!selectedChar,
      author_character_id: selectedCharacterId || null,
      author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
      owner_name: profile?.nickname || guestNickname.trim() || user?.displayName || profile?.email?.split('@')[0] || 'Guest'
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
    if (draftSaving) return;
    if (!editContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }
    setDraftSaving(true);
    try {
      const selectedChar = characters.find(c => c.id === editCharacterId);
      const metadata = {
        author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'),
        author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
        author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
        author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
        is_character: !!selectedChar,
        author_character_id: editCharacterId || null
      };

      await updateDraftPost(user.uid, id, editContent.trim(), metadata);
      setEditingPostId(null);
      setEditContent('');
      setEditCharacterId('');
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

      const postsBeforeNew = (currentPage - 1) * ITEMS_PER_PAGE + posts.length;
      const newTotalPosts = postsBeforeNew + 1;
      const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

      setTopic(prev => prev ? {
        ...prev,
        posts_count: Math.max(newTotalPosts, (prev.posts_count || 0) + 1),
        last_post_at: new Date().toISOString()
      } : prev);

      if (prevTopicStatsRef.current) {
        prevTopicStatsRef.current.posts_count = Math.max(newTotalPosts, (prevTopicStatsRef.current.posts_count || 0) + 1);
        prevTopicStatsRef.current.last_post_at = new Date().toISOString();
      }

      if (targetPage !== currentPage) {
        alreadyJumpedRef.current = false;
        setSearchParams({ page: targetPage, goLast: '1' }, { preventScrollReset: true });
      } else {
        await loadPosts(currentPage);
      }
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
    setEditCharacterId(post.author_character_id || '');
    setEditingFirstPost(isFirst);
    if (isFirst && topic) {
      setEditTopicTitle(topic.title || '');
      setEditTopicDescription(topic.description || '');
      setEditPinFirstPost(topic.first_post_pinned || false);
    }
  };

  const handleSaveEdit = async (postId) => {
    if (!editContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }
    recordActivity();
    try {
      const originalPost = posts.find(p => p.id === postId);

      let metadata = {};
      // If the character ID has changed, we must update the "frozen" display fields
      if (editCharacterId !== (originalPost?.author_character_id || '')) {
        const selectedChar = characters.find(c => c.id === editCharacterId);
        metadata = {
          author_name: selectedChar ? selectedChar.name : (profile?.nickname || user.displayName || profile?.email?.split('@')[0] || 'User'),
          author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
          author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
          author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
          is_character: !!selectedChar,
          author_character_id: editCharacterId || null
        };
      }

      await updatePost(postId, editContent.trim(), metadata, user.uid, originalPost?.author_id);
      if (editingFirstPost && topic) {
        await updateTopic(topic.id, {
          title: editTopicTitle.trim() || topic.title,
          description: editTopicDescription.trim(),
          first_post_pinned: editPinFirstPost
        }, user.uid, topic.author_id);
      }
      await loadPosts();
      setEditingPostId(null);
      setEditContent('');
      setEditCharacterId('');
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
        const isFirstPost = posts.length > 0 && posts[0].id === deletingPost.id;
        const categoryId = topic?.category_id;

        if (isFirstPost) {
          await deleteTopics([id], user.uid);
          if (categoryId) {
            navigate(`/category/${categoryId}`);
            return;
          } else {
            navigate('/');
            return;
          }
        } else {
          const delAuthorId = deletingPost.author_id;
          await deletePost(deletingPost, user.uid);
          if (delAuthorId) {
            if (delAuthorId === user?.uid) {
              setProfile(prev => prev ? { ...prev, post_count: Math.max(0, (prev.post_count || 0) - 1) } : prev);
            }
            setAuthorStats(prev => prev[delAuthorId] ? {
              ...prev,
              [delAuthorId]: {
                ...prev[delAuthorId],
                post_count: Math.max(0, (prev[delAuthorId].post_count || 0) - 1)
              }
            } : prev);
          }
          await loadPosts();
        }
      }
      setDeletingPost(null);
    } catch (err) {
      console.error(err);
      alert('Error deleting post');
    }
  };

  const canManagePost = (post) => {
    if (!user || profile?.role_id === 'pending') return false;
    return post.author_id === user.uid || hasPermission('moderate_content');
  };

  const getRoleBadge = (post, extraClass = 'mb-2') => {
    if (post.is_character) {
      return (
        <div className={`mt-0 ${extraClass} text-center w-100`}>
          <ForumCharacterBadge ownerName={getLiveOwnerName(post)} />
        </div>
      );
    }

    // Check author data from stats
    if (!post.author_id) {
      return <ForumRoleBadge roleId="guest" className={extraClass} />;
    }
    const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];

    // If it's undefined, it's still loading (we explicitly set null for 'not found')
    if (authorData === undefined) {
      return <div className={`skeleton skeleton-badge ${extraClass}`}></div>;
    }

    return (
      <ForumRoleBadge
        roleId={authorData?.role_id || post.author_role_id}
        status={authorData?.status}
        userEmail={authorData?.email}
        isDeleted={authorData === null}
        className={extraClass}
      />
    );
  };

  // ── Render Components ──────────────────────────────────────────────────

  const TopicPageSkeleton = () => (
    <Container className="py-4 skeleton-fade-in">
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
                <Skeleton width="150px" height="1.5rem" />
              </div>
            </Col>
          </Row>
        </Card>
      ))}
    </Container>
  );

  // Show access denied page if either subscribeToTopic or loadPosts failed with permissions
  if (accessError) {
    return (
      <Container className="py-5 text-center">
        <h3 className="text-muted">{lang === 'ru' ? 'Доступ запрещён' : 'Access Denied'}</h3>
        <p className="text-muted">{lang === 'ru' ? 'У вас нет прав для просмотра этой темы.' : 'You do not have permission to view this topic.'}</p>
        <Button as={Link} to="/" variant="outline-primary" className="mt-3">
          {lang === 'ru' ? 'На главную' : 'Go Home'}
        </Button>
      </Container>
    );
  }

  // Full-page skeleton only when topic data hasn't loaded at all (first visit)
  if (!topic) {
    return <TopicPageSkeleton />;
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

  const categoryTitle = category ? resolveField(category.title, lang) : '...';
  const hasDraft = !!myDraft;

  // Pagination logic — server-side: `posts` already contains only the current page.
  // `totalPages` is derived from the topic's authoritative posts_count counter.
  const realPosts = posts;
  const totalPages = Math.ceil((topic?.posts_count ?? realPosts.length) / ITEMS_PER_PAGE) || 1;
  // indexOfFirstItem is used only for post numbering (e.g. "#42")
  const indexOfFirstItem = (currentPage - 1) * ITEMS_PER_PAGE;
  const currentPosts = realPosts; // Already the correct page from the server
  const isOnLastPage = currentPage >= totalPages || totalPages === 0;

  const handlePageChange = (page, isFromBottom = false) => {
    setSearchParams({ page });
    if (isFromBottom) {
      setTimeout(() => {
        const topElement = document.querySelector('.topic-header-area') || document.querySelector('.posts-container');
        if (topElement) {
          const skipOffset = 70; // Header height
          const y = topElement.getBoundingClientRect().top + window.scrollY - skipOffset;
          window.scrollTo({ top: y, behavior: 'instant' });
        } else {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      }, 0);
    }
  };

  const needsJump = (searchParams.get('post') || searchParams.get('goLast') === '1' || hash.startsWith('#post-'));
  const isJumping = needsJump && !alreadyJumpedRef.current;

  return (
    <Container className={`py-4 position-relative ${isJumping ? 'topic-jump-loading' : ''}`}>
      {isJumping && (
        <div className="position-absolute top-0 start-0 w-100 h-100 skeleton-jump-placeholder" style={{ zIndex: 10, minHeight: '100vh' }}>
          <TopicPageSkeleton />
        </div>
      )}

      <div className="topic-content-wrapper">
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
              <Timestamp date={topic.created_at} />
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
                            const newPinned = !topic.is_pinned;
                            setTopic(prev => prev ? { ...prev, is_pinned: newPinned } : prev);
                            try {
                              await updateTopic(id, { is_pinned: newPinned });
                              showToast(lang === 'ru'
                                ? (newPinned ? 'Тема закреплена' : 'Тема откреплена')
                                : (newPinned ? 'Topic pinned' : 'Topic unpinned')
                              );
                            } catch (error) {
                              setTopic(prev => prev ? { ...prev, is_pinned: !newPinned } : prev);
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
                            const newLocked = !topic.is_locked;
                            setTopic(prev => prev ? { ...prev, is_locked: newLocked } : prev);
                            try {
                              await updateTopic(id, { is_locked: newLocked });
                              showToast(lang === 'ru'
                                ? (newLocked ? 'Тема закрыта' : 'Тема открыта')
                                : (newLocked ? 'Topic locked' : 'Topic unlocked')
                              );
                            } catch (error) {
                              setTopic(prev => prev ? { ...prev, is_locked: !newLocked } : prev);
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
                        <Dropdown.Item
                          onClick={() => setShowMovePostsModal(true)}
                          className="d-flex align-items-center gap-2"
                        >
                          <MessageSquare size={14} />
                          {t('forum.move_posts')}
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
                <div className="pagination-top">
                  <ForumPagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Pinned First Post — shown on pages 2+ when topic.first_post_pinned is true */}
        {topic.first_post_pinned && currentPage > 1 && pinnedFirstPost && (() => {
          const firstPost = pinnedFirstPost;
          return (
            <Card
              key="pinned-first-post"
              id="pinned-first-post"
              className="mb-4 shadow-sm border-0 post-card pinned-first-post-card"
            >
              {/* Pinned marker strip */}
              <div className="pinned-first-post-strip d-flex align-items-center gap-2 px-3 py-1">
                <Pin size={13} fill="currentColor" />
                <span className="fw-semibold" style={{ fontSize: '0.75rem' }}>{t('forum.first_post_pinned_label')}</span>
              </div>
              <Card.Body className="p-0">
                <div className="d-flex flex-column flex-md-row flex-md-nowrap">
                  {/* Author sidebar */}
                  <div className="author-sidebar border-end p-2 px-md-2 pt-md-2 pb-md-0 text-center d-flex flex-column align-items-center">
                    <div className="d-none d-md-flex flex-column align-items-center w-100 h-100">
                      <div className="fw-bold text-center mb-1 text-truncate w-100">
                        <ForumAuthorName
                          userId={firstPost.author_id}
                          characterId={firstPost.author_character_id}
                          isCharacter={!!firstPost.is_character}
                          fallbackName={firstPost.author_name}
                          onClick={handleQuoteAuthor}
                        />
                      </div>
                      {getLiveAuthorStatus(firstPost) === 'LOADING' ? (
                        <div className="skeleton mb-2 mx-auto" style={{ width: '80%', height: '14px' }}></div>
                      ) : getLiveAuthorStatus(firstPost) ? (
                        <div className="text-primary mb-2 w-100 px-2 text-center" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                          {getLiveAuthorStatus(firstPost)}
                        </div>
                      ) : null}
                      <div className="mb-2">
                        <ForumAuthorAvatar
                          userId={firstPost.author_id}
                          characterId={firstPost.author_character_id}
                          isCharacter={!!firstPost.is_character}
                          fallbackName={firstPost.author_name}
                          initialAvatar={firstPost.author_avatar}
                          size={150}
                          className="rounded shadow-sm"
                          isOnline={isAuthorOnline(firstPost)}
                        />
                      </div>
                      <div className="mt-2 mb-2 text-center w-100">{getRoleBadge(firstPost)}</div>
                      {(() => {
                        const authorData = firstPost.author_id === user?.uid ? profile : authorStats[firstPost.author_id];
                        if (!authorData) return null;
                        return (
                          <div className="mt-auto border-top w-100 d-flex gap-3 justify-content-center border-top-dashed align-items-center" style={{ height: '34px' }}>
                            <Link to={`/profile/${firstPost.author_id}`} className="footer-link text-decoration-none px-0">
                              {t('profile.view_profile')}
                            </Link>
                          </div>
                        );
                      })()}
                    </div>
                    {/* Mobile */}
                    <div className="d-md-none d-flex flex-row align-items-center gap-2 w-100">
                      <div className="author-avatar-wrapper flex-shrink-0 hide-on-extra-small-mobile">
                        <ForumAuthorAvatar
                          userId={firstPost.author_id}
                          characterId={firstPost.author_character_id}
                          isCharacter={!!firstPost.is_character}
                          fallbackName={firstPost.author_name}
                          initialAvatar={firstPost.author_avatar}
                          size={60}
                          className="rounded shadow-sm"
                          isOnline={isAuthorOnline(firstPost)}
                        />
                      </div>
                      <div className="flex-grow-1 text-start overflow-hidden">
                        <div className="fw-bold text-truncate author-res-nickname">
                          <ForumAuthorName
                            userId={firstPost.author_id}
                            characterId={firstPost.author_character_id}
                            isCharacter={!!firstPost.is_character}
                            fallbackName={firstPost.author_name}
                            onClick={handleQuoteAuthor}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="d-flex flex-column flex-grow-1" style={{ minHeight: '100%', minWidth: 0 }}>
                    <div className="post-header-strip px-2 px-md-4 py-1 d-flex justify-content-between align-items-center">
                      <small className="text-muted">
                        <Timestamp date={firstPost.created_at} className="text-muted" />
                      </small>
                    </div>
                    <div className="px-2 px-md-4 py-2 flex-grow-1 d-flex flex-column">
                      <div className="flex-grow-1">
                        <div className="post-content">
                          <BBCode rolls={firstPost.rolls} authorId={firstPost.author_id}>{firstPost.content}</BBCode>
                        </div>
                        {getLiveAuthorSignature(firstPost) && (
                          <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                            <BBCode>{getLiveAuthorSignature(firstPost)}</BBCode>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Quote button */}
                    {hasPermission(PERMISSIONS.POST_REPLY, { category }) && (!topic.is_locked || hasPermission('moderate_content')) && (
                      <div className="px-2 px-md-4 mt-auto d-flex flex-wrap justify-content-end align-items-center gap-3 border-top border-top-dashed" style={{ height: '34px' }}>
                        <Button
                          variant="link"
                          size="sm"
                          className="footer-link p-0"
                          onClick={() => {
                            const author = getLiveAuthorName(firstPost) || 'User';
                            const quote = `[quote="#p${firstPost.id},t${id},${author}"]\n${firstPost.content}\n[/quote]\n\n`;
                            setReplyContent(prev => {
                              const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
                              return prev + separator + quote;
                            });
                            replyRef.current?.scrollIntoView({ behavior: 'smooth' });
                          }}
                        >
                          {lang === 'ru' ? 'Цитировать' : 'Quote'}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </Card.Body>
            </Card>
          );
        })()}

        {/* Posts */}
        <div className="posts-container">
          {currentPosts.length === 0 && isPageLoading ? (
            /* Inline skeleton while page posts are loading (pagination) */
            [...Array(3)].map((_, i) => (
              <Card key={`skel-${i}`} className="mb-4 post-card shadow-sm border-0 overflow-hidden skeleton-fade-in">
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
                    <div>
                      <Skeleton width="100%" height="1rem" className="mb-2" />
                      <Skeleton width="100%" height="1rem" className="mb-2" />
                      <Skeleton width="85%" height="1rem" className="mb-2" />
                      <Skeleton width="40%" height="1rem" />
                    </div>
                    <div className="mt-5 pt-3 border-top">
                      <Skeleton width="150px" height="1.5rem" />
                    </div>
                  </Col>
                </Row>
              </Card>
            ))
          ) : currentPosts.map((post, index) => (
            <Card key={post.id} id={`post-${post.id}`} className="mb-4 shadow-sm border-0 post-card">
              <Card.Body className="p-0">
                <div className="d-flex flex-column flex-md-row flex-md-nowrap">
                  {/* Author sidebar */}
                  <div className="author-sidebar border-end p-2 px-md-2 pt-md-2 pb-md-0 text-center d-flex flex-column align-items-center">
                    {/* --- DESKTOP VERSION (Stay as it was) --- */}
                    <div className="d-none d-md-flex flex-column align-items-center w-100 h-100">
                      {/* 1. Nickname */}
                      <div className="fw-bold text-center mb-1 text-truncate w-100">
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
                        <div className="skeleton mb-2 mx-auto" style={{ width: '80%', height: '14px' }}></div>
                      ) : getLiveAuthorStatus(post) ? (
                        <div className="text-primary mb-2 w-100 px-2 text-center" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
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
                          size={150}
                          className="rounded shadow-sm"
                          isOnline={isAuthorOnline(post)}
                        />
                      </div>

                      {/* 4. Posts Count */}
                      {post.author_id && (
                        <div className="text-muted mt-1 opacity-75" style={{ fontSize: '0.775rem' }}>
                          {t('profile.posts_count')}: <strong>{authorStats[post.author_id]?.post_count ?? post.author_posts_count ?? 0}</strong>
                        </div>
                      )}

                      {/* 5. Reputation */}
                      {post.author_id && (
                        <div className="text-muted" style={{ fontSize: '0.775rem' }}>
                          {t('profile.reputation')}: <strong>{authorStats[post.author_id]?.reputation ?? post.author_reputation ?? 0}</strong>
                        </div>
                      )}

                      {/* 6. Role/Mask */}
                      <div className="mt-2 mb-2 text-center w-100">{getRoleBadge(post)}</div>

                      {/* Desktop profile links */}
                      {(() => {
                        const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];
                        if (!authorData) return null;

                        return (
                          <div className="mt-auto border-top w-100 d-flex gap-3 justify-content-center border-top-dashed align-items-center" style={{ height: '34px' }}>
                            <Link to={`/profile/${post.author_id}`} className="footer-link text-decoration-none px-0">
                              {t('profile.view_profile')}
                            </Link>
                            {hasPermission(PERMISSIONS.USE_DIRECT_MESSAGES) && authorData.role_id !== 'banned' && post.author_id !== user?.uid && (
                              <Link to={`/messages/${post.author_id}`} className="footer-link text-decoration-none px-0">
                                {t('profile.pm')}
                              </Link>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* --- MOBILE VERSION (Compact & Horizontal) --- */}
                    <div className="d-md-none d-flex flex-row align-items-center gap-2 w-100">
                      {/* Avatar */}
                      <div className="author-avatar-wrapper flex-shrink-0 hide-on-extra-small-mobile">
                        <ForumAuthorAvatar
                          userId={post.author_id}
                          characterId={post.author_character_id}
                          isCharacter={!!post.is_character}
                          fallbackName={post.author_name}
                          initialAvatar={post.author_avatar}
                          size={60}
                          className="rounded shadow-sm"
                          isOnline={isAuthorOnline(post)}
                        />
                      </div>

                      {/* Info Group */}
                      <div className="flex-grow-1 text-start overflow-hidden">
                        <div className="fw-bold text-truncate author-res-nickname">
                          <ForumAuthorName
                            userId={post.author_id}
                            characterId={post.author_character_id}
                            isCharacter={!!post.is_character}
                            fallbackName={post.author_name}
                            onClick={handleQuoteAuthor}
                          />
                        </div>
                        {getLiveAuthorStatus(post) && (
                          <div className="text-primary author-res-status" style={{ fontStyle: 'italic', lineHeight: '1.2' }}>
                            {getLiveAuthorStatus(post)}
                          </div>
                        )}
                      </div>

                      {/* Stats & Role Group */}
                      <div className="text-end author-stats-group ms-auto">
                        <div className="d-flex flex-column align-items-end gap-1">
                          {post.author_id && (
                            <div className="text-muted author-res-stat">
                              {lang === 'ru' ? 'Постов' : 'Posts'}: <strong className="ms-1">{authorStats[post.author_id]?.post_count ?? post.author_posts_count ?? 0}</strong>
                            </div>
                          )}
                          {post.author_id && (
                            <div className="text-muted author-res-stat">
                              {lang === 'ru' ? 'Реп' : 'Rep'}: <strong className="ms-1">{authorStats[post.author_id]?.reputation ?? post.author_reputation ?? 0}</strong>
                            </div>
                          )}
                          <div className="author-res-info-lite text-end">
                            {getRoleBadge(post, 'mb-0')}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Content Area */}
                  <div className="d-flex flex-column flex-grow-1" style={{ minHeight: '100%', minWidth: 0 }}>
                    {/* Header Strip: Time, # */}
                    <div className="post-header-strip px-2 px-md-4 py-1 d-flex justify-content-between align-items-center">
                      <small className="text-muted">
                        <a
                          href={`/topic/${id}?post=${post.id}`}
                          className="text-decoration-none text-muted hover-link"
                          onClick={(e) => {
                            e.preventDefault();
                            const url = `${window.location.origin}/topic/${id}?post=${post.id}`;
                            navigator.clipboard.writeText(url);
                            showToast(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
                          }}
                        >
                          <Timestamp date={post.created_at} className="text-muted" />
                        </a>
                        {post.edited_at && (
                          <span className="d-block d-md-inline-block ms-md-2 opacity-50">
                            ({lang === 'ru' ? 'ред.' : 'edited'} <Timestamp date={post.edited_at} />)
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
                                <Form.Check
                                  type="checkbox"
                                  id="editPinFirstPost"
                                  label={t('forum.pin_first_post')}
                                  checked={editPinFirstPost}
                                  onChange={(e) => setEditPinFirstPost(e.target.checked)}
                                  className="mt-2"
                                />
                              </div>
                            )}
                            <div className="mb-2">
                              <div className="d-flex align-items-center justify-content-between mb-2">
                                {post.author_id === user?.uid && (
                                  <Dropdown className="w-auto">
                                    <Dropdown.Toggle
                                      variant="outline-management"
                                      size="sm"
                                      className="d-flex align-items-center gap-2 custom-select-toggle"
                                    >
                                      <User size={14} />
                                      <span className="text-truncate" style={{ maxWidth: '200px' }}>
                                        {editCharacterId
                                          ? `${t('forum.post_as_character')}: ${characters.find(c => c.id === editCharacterId)?.name || '...'}`
                                          : `${t('forum.post_as_user')}: ${profile?.nickname || profile?.email?.split('@')[0]}`
                                        }
                                      </span>
                                    </Dropdown.Toggle>
                                    <Dropdown.Menu className="shadow-sm border-0 custom-select-menu">
                                      <Dropdown.Item
                                        active={editCharacterId === ''}
                                        onClick={() => setEditCharacterId('')}
                                      >
                                        {t('forum.post_as_user')}: {profile?.nickname || profile?.email?.split('@')[0]}
                                      </Dropdown.Item>
                                      {characters.length > 0 && <Dropdown.Divider />}
                                      {characters.map(char => (
                                        <Dropdown.Item
                                          key={char.id}
                                          active={editCharacterId === char.id}
                                          onClick={() => setEditCharacterId(char.id)}
                                        >
                                          {t('forum.post_as_character')}: {char.name}
                                        </Dropdown.Item>
                                      ))}
                                    </Dropdown.Menu>
                                  </Dropdown>
                                )}
                                <Button
                                  variant="outline-management"
                                  size="sm"
                                  className="ms-auto d-none d-md-flex align-items-center"
                                  onClick={() => editEditorRef.current?.openHotkeysModal()}
                                  title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
                                >
                                  <Keyboard size={16} />
                                </Button>
                              </div>
                              <RichEditor
                                ref={editEditorRef}
                                id="editContent"
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                rows={6}
                                minHeight="210px"
                                maxLength={computedMaxChars}
                                autoFocus={true}
                                showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                                isEdit={true}
                                hideHotkeysButton={true}
                                onSubmit={() => handleSaveEdit(post.id)}
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
                            <BBCode rolls={post.rolls} authorId={post.author_id}>{post.content}</BBCode>
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
                      {settings?.enableReputation && post.author_id && (post.author_id === user?.uid ? profile : authorStats[post.author_id]) !== null && (
                        <div className="mt-3 d-flex justify-content-end align-items-center gap-3 reputation-section">
                          <ReputationHoverPreview
                            postId={post.id}
                            targetUid={post.author_id}
                            lang={lang}
                            disabled={!post.reputation}
                          >
                            <div
                              className={`text-muted small d-flex align-items-center gap-1 ${post.author_id && post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (post.author_id === user?.uid ? profile : authorStats[post.author_id])?.status !== 'banned' ? 'rep-trigger' : ''}`}
                              title={post.author_id && post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (post.author_id === user?.uid ? profile : authorStats[post.author_id])?.status !== 'banned'
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
                                } else if (settings?.reputationStyle === 'positive_only') {
                                  handleOpenVoteModal(post, 1, index + indexOfFirstItem + 1);
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
                          </ReputationHoverPreview>


                          {activeRepPostId === post.id && !myVotes[post.id] && post.author_id !== profile?.uid && hasPermission(PERMISSIONS.USE_REPUTATION) && (
                            <div className="reputation-controls d-flex align-items-center rounded px-2 py-1 gap-2 animate-fade-in shadow-sm">
                              <div className="d-flex gap-1">
                                {settings?.reputationStyle !== 'positive_only' && (
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
                                )}
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
                    {((user && profile?.role_id !== 'pending' && profile?.role_id !== 'spectator') || hasPermission(PERMISSIONS.POST_REPLY, { category })) && (
                      (!topic?.is_locked || hasPermission('moderate_content')) || canManagePost(post)
                    ) && (
                        <div className="px-2 px-md-4 mt-auto d-flex flex-wrap justify-content-between align-items-center gap-3 border-top border-top-dashed" style={{ height: '34px' }}>
                          {/* Left side: Profile Links (Mobile Only) */}
                          <div className="d-flex d-md-none gap-3">
                            {(() => {
                              const authorData = post.author_id === user?.uid ? profile : authorStats[post.author_id];
                              if (!authorData) return null;
                              return (
                                <>
                                  <Link to={`/profile/${post.author_id}`} className="author-res-footer-link">
                                    {t('profile.view_profile')}
                                  </Link>
                                  {user && profile?.role_id !== 'pending' && profile?.role_id !== 'spectator' && authorData.role_id !== 'banned' && post.author_id !== user?.uid && (
                                    <Link to={`/messages/${post.author_id}`} className="author-res-footer-link">
                                      {t('profile.pm')}
                                    </Link>
                                  )}
                                </>
                              );
                            })()}
                          </div>

                          {/* Placeholder for desktop formatting if needed, or hide div if empty on desktop */}
                          <div className="d-none d-md-block"></div>

                          {/* Right side: Management Actions */}
                          <div className="d-flex gap-2 gap-md-3">
                            {canManagePost(post) && (!topic.is_locked || hasPermission('moderate_content')) && (
                              <>
                                <Button
                                  variant="link"
                                  size="sm"
                                  className="footer-link p-0 text-danger"
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

                                  if (post.rolls) {
                                    content = content.replace(/\[roll=([a-z0-9_]+)\]/gi, (match, id) => {
                                      const r = post.rolls[id];
                                      if (r) {
                                        return `[roll=${id} value=${r.value} sides=${r.sides}${r.type ? ` type=${r.type}` : ''}]`;
                                      }
                                      return match;
                                    });
                                  }

                                  const stripQuotes = (text) => {
                                    let result = '';
                                    let depth = 0;
                                    const regex = /\[(\/?)(quote)(?:[\s=][^\]]*)?\]/gi;
                                    let match;
                                    let lastIndex = 0;

                                    while ((match = regex.exec(text)) !== null) {
                                      if (depth === 0) {
                                        result += text.substring(lastIndex, match.index);
                                      }
                                      if (match[1] === '/') {
                                        depth = Math.max(0, depth - 1);
                                      } else {
                                        depth++;
                                      }
                                      lastIndex = regex.lastIndex;
                                    }
                                    if (depth === 0) {
                                      result += text.substring(lastIndex);
                                    }
                                    return result.trim();
                                  };

                                  const cleanContent = stripQuotes(content);
                                  const quote = `[quote="#p${post.id},t${id},${author}"]\n${cleanContent}\n[/quote]\n\n`;

                                  setReplyContent(prev => {
                                    const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
                                    return prev + separator + quote;
                                  });
                                  window.getSelection().removeAllRanges();
                                  replyRef.current?.scrollIntoView({ behavior: 'smooth' });
                                }}
                              >
                                {lang === 'ru' ? 'Цитировать' : 'Quote'}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                  </div>
                </div>
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
              <div className="d-flex flex-column flex-md-row flex-md-nowrap">
                {/* Author sidebar */}
                <div className="author-sidebar border-end px-2 pt-2 pb-0 text-center d-flex flex-column align-items-center">
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
                    <div className="text-primary mb-2 w-100 px-2" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                      {getLiveAuthorStatus(myDraft)}
                    </div>
                  )}
                  <div className="mb-2 hide-on-extra-small-mobile">
                    <ForumAuthorAvatar
                      userId={myDraft.author_id}
                      characterId={myDraft.author_character_id}
                      isCharacter={!!myDraft.is_character}
                      fallbackName={myDraft.author_name}
                      initialAvatar={myDraft.author_avatar}
                      size={150}
                      className="rounded shadow-sm"
                      isOnline={!!user}
                    />
                  </div>
                  <div className="text-muted mt-1" style={{ fontSize: '0.8rem' }}>
                    {t('profile.posts_count')}: <strong>{authorStats[myDraft.author_id]?.post_count || 0}</strong>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                    {t('profile.reputation')}: <strong>{authorStats[myDraft.author_id]?.reputation || 0}</strong>
                  </div>
                  <div className="mt-2 mb-3 text-center w-100">{getRoleBadge(myDraft)}</div>
                  {/* Draft Status Links */}
                  <div className="mt-auto py-2 border-top w-100 d-flex gap-3 justify-content-center border-top-dashed">
                    <Link to={`/profile/${myDraft.author_id}`} className="footer-link text-decoration-none px-0">
                      {t('profile.view_profile')}
                    </Link>
                  </div>
                </div>

                {/* Content Area */}
                <div className="d-flex flex-column flex-grow-1" style={{ minHeight: '100%', minWidth: 0 }}>
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
                        <div className="pb-3">
                          <div className="mb-2">
                            <div className="d-flex align-items-center justify-content-between mb-2">
                              <Dropdown className="w-auto">
                                <Dropdown.Toggle
                                  variant="outline-management"
                                  size="sm"
                                  className="d-flex align-items-center gap-2 custom-select-toggle"
                                >
                                  <User size={14} />
                                  <span className="text-truncate" style={{ maxWidth: '200px' }}>
                                    {editCharacterId
                                      ? `${t('forum.post_as_character')}: ${characters.find(c => c.id === editCharacterId)?.name || '...'}`
                                      : `${t('forum.post_as_user')}: ${profile?.nickname || profile?.email?.split('@')[0]}`
                                    }
                                  </span>
                                </Dropdown.Toggle>
                                <Dropdown.Menu className="shadow-sm border-0 custom-select-menu">
                                  <Dropdown.Item
                                    active={editCharacterId === ''}
                                    onClick={() => setEditCharacterId('')}
                                  >
                                    {t('forum.post_as_user')}: {profile?.nickname || profile?.email?.split('@')[0]}
                                  </Dropdown.Item>
                                  {characters.length > 0 && <Dropdown.Divider />}
                                  {characters.map(char => (
                                    <Dropdown.Item
                                      key={char.id}
                                      active={editCharacterId === char.id}
                                      onClick={() => setEditCharacterId(char.id)}
                                    >
                                      {t('forum.post_as_character')}: {char.name}
                                    </Dropdown.Item>
                                  ))}
                                </Dropdown.Menu>
                              </Dropdown>
                              <Button
                                variant="outline-management"
                                size="sm"
                                className="ms-auto d-none d-md-flex align-items-center"
                                onClick={() => draftEditorRef.current?.openHotkeysModal()}
                                title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
                              >
                                <Keyboard size={16} />
                              </Button>
                            </div>
                            <RichEditor
                              ref={draftEditorRef}
                              id="draftEditContent"
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              rows={6}
                              minHeight="210px"
                              maxLength={computedMaxChars}
                              autoFocus={true}
                              showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                              isEdit={true}
                              hideHotkeysButton={true}
                              onSubmit={() => handleUpdateDraft(myDraft.id)}
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
                          <BBCode rolls={myDraft.rolls} authorId={myDraft.author_id || user?.uid}>{myDraft.content}</BBCode>
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
                  {!editingPostId && (
                    <div className="px-2 px-md-4 py-2 mt-auto d-flex justify-content-end gap-3 border-top border-top-dashed post-footer-links">
                      <Button
                        variant="link"
                        size="sm"
                        className="footer-link p-0"
                        onClick={() => setDeletingPost(myDraft)}
                      >
                        {t('common.delete')}
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        className="footer-link p-0"
                        onClick={() => handleStartEdit(myDraft, false)}
                      >
                        {t('common.edit')}
                      </Button>
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
                    </div>
                  )}
                </div>
              </div>
            </Card.Body>
          </Card>
        )}

        {/* Bottom Actions & Pagination */}
        <div className="mt-4 mb-4 px-2 px-md-0">
          {user && profile?.role_id !== 'pending' && profile?.role_id !== 'banned' && profile?.role_id !== 'spectator' && (
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
          <div className="d-flex justify-content-center pagination-bottom">
            <ForumPagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={(page) => handlePageChange(page, true)}
              centered
            />
          </div>
        </div>

        {/* Reply form — hidden for spectators and closed topics */}
        {
          !hasPermission(PERMISSIONS.POST_REPLY, { category }) ? (
            user && profile?.role_id !== 'pending' && profile?.role_id !== 'banned' && (
              <div className="mt-5 p-4 text-center text-muted border rounded" ref={replyRef}>
                <span className="opacity-75">
                  {t('forum.spectator_mode')}
                </span>
              </div>
            )
          ) : topic.posts_count >= (settings?.maxPostsPerTopic ?? 1000) ? (
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
                        ? `В теме достигнут лимит сообщений (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}). Новые ответы более не принимаются.`
                        : `The message limit (${settings?.maxPostsPerTopic ?? 1000}/${settings?.maxPostsPerTopic ?? 1000}) has been reached for this topic. New replies are no longer accepted.`}
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
                    {!user && (
                      <Form.Group className="mb-3" controlId="guestNickname">
                        <Form.Label className="fw-semibold small">
                          {lang === 'ru' ? 'Ваш никнейм' : 'Your Nickname'} <span className="text-danger">*</span>
                        </Form.Label>
                        <Form.Control
                          type="text"
                          placeholder={lang === 'ru' ? 'Введите имя...' : 'Enter your name...'}
                          value={guestNickname}
                          onChange={(e) => setGuestNickname(e.target.value)}
                          required
                          className="w-auto"
                          style={{ minWidth: '250px' }}
                        />
                      </Form.Group>
                    )}
                    <div className="d-flex align-items-center justify-content-between mb-2">
                      {user && hasPermission(PERMISSIONS.USE_MASKS, { category }) && (
                        <Dropdown className="w-auto">
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
                      )}
                      <Button
                        variant="outline-management"
                        className={`ms-auto d-none d-md-flex align-items-center gap-2 ${!(user && hasPermission(PERMISSIONS.USE_MASKS, { category })) ? 'mb-2' : ''}`}
                        onClick={() => replyEditorRef.current?.openHotkeysModal()}
                        title={lang === 'ru' ? 'Горячие клавиши (Ctrl+/)' : 'Hotkeys (Ctrl+/)'}
                      >
                        <Keyboard size={18} />
                        <span className="d-none d-md-inline small">{lang === 'ru' ? 'Справка' : 'Help'}</span>
                      </Button>
                    </div>

                    <Form.Group className="mb-3">
                      <RichEditor
                        ref={replyEditorRef}
                        id="reply-editor"
                        value={replyContent}
                        onChange={(e) => setReplyContent(e.target.value)}
                        placeholder={t('forum.reply_placeholder')}
                        minHeight="210px"
                        rows={6}
                        maxLength={computedMaxChars}
                        showDice={hasPermission(PERMISSIONS.USE_DICE, { category })}
                        isEdit={false}
                        hideHotkeysButton={true}
                        onSubmit={() => handleReply()}
                      />
                    </Form.Group>

                    <div className="mt-4 d-flex justify-content-end gap-2">
                      {user && !hasDraft && (
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
        {(() => {
          const isFirstPost = deletingPost && !deletingPost.is_draft && posts.length > 0 && posts[0].id === deletingPost.id;
          return (
            <ConfirmModal
              show={!!deletingPost}
              onHide={() => setDeletingPost(null)}
              onConfirm={handleDeletePost}
              title={lang === 'ru'
                ? (isFirstPost ? 'Удалить тему?' : 'Удалить пост?')
                : (isFirstPost ? 'Delete topic?' : 'Delete post?')}
              message={lang === 'ru'
                ? (isFirstPost
                  ? 'Внимание: удаление первого сообщения приведет к удалению всей темы целиком. Это действие необратимо.'
                  : 'Это действие необратимо. Пост будет удалён навсегда.')
                : (isFirstPost
                  ? 'Warning: deleting the first post will delete the entire topic. This action cannot be undone.'
                  : 'This action cannot be undone. The post will be permanently deleted.')}
              confirmText={lang === 'ru' ? 'Удалить' : 'Delete'}
              cancelText={lang === 'ru' ? 'Отмена' : 'Cancel'}
            />
          );
        })()}

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

        {/* Move Posts Modal */}
        <MovePostsModal
          show={showMovePostsModal}
          onHide={() => setShowMovePostsModal(false)}
          posts={posts}
          firstPostId={posts[0]?.id}
          currentTopicId={id}
          onConfirm={handleMovePosts}
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
                  <div className="fw-bold"><Timestamp date={selectedVote.created_at} /></div>
                </div>
              </div>

              <div>
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <div className="small text-muted">{lang === 'ru' ? 'Ваш комментарий' : 'Your comment'}</div>
                  {(selectedVote.voter_id === user?.uid) && !isEditingRepComment && (
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-decoration-none small"
                      onClick={() => {
                        setEditingRepComment(selectedVote.comment || '');
                        setIsEditingRepComment(true);
                      }}
                    >
                      {selectedVote.comment ? (lang === 'ru' ? 'Изменить' : 'Edit') : (lang === 'ru' ? 'Добавить' : 'Add')}
                    </Button>
                  )}
                </div>

                {isEditingRepComment ? (
                  <div className="modal-inner-card p-3 border-start border-4 border-accent">
                    <Form.Control
                      as="textarea"
                      rows={2}
                      value={editingRepComment}
                      onChange={(e) => setEditingRepComment(e.target.value)}
                      placeholder={lang === 'ru' ? 'Введите комментарий...' : 'Enter your comment...'}
                      className="modal-section-themed mb-2"
                    />
                    <div className="d-flex justify-content-end gap-2">
                      <Button
                        variant="outline-secondary"
                        size="sm"
                        onClick={() => setIsEditingRepComment(false)}
                        disabled={savingRepComment}
                      >
                        {t('common.cancel')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleUpdateRepComment}
                        disabled={savingRepComment}
                      >
                        {savingRepComment ? t('common.loading') : (lang === 'ru' ? 'Сохранить' : 'Save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 modal-inner-card border-start border-4 border-accent" style={{ minHeight: '60px' }}>
                    {selectedVote.comment || (lang === 'ru' ? <span className="opacity-50 italic">Без комментария</span> : <span className="opacity-50 italic">No comment left</span>)}
                  </div>
                )}
              </div>

              <div className="small text-muted opacity-75 italic text-center mt-2">
                {lang === 'ru'
                  ? 'Этот голос зачислен автору поста.'
                  : 'This vote has been contributed to the post author.'}
              </div>
            </div>
          )}
        </ForumModal>
      </div>

    </Container>
  );
};

export default TopicPage;
