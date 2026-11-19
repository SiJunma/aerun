import { useCallback } from 'react';
import ForumCharacterBadge from '../../components/common/ForumCharacterBadge';
import ForumRoleBadge from '../../components/common/ForumRoleBadge';

/**
 * useTopicPostAuth: Custom hook for author-related helpers and post quoting.
 */
export const useTopicPostAuth = ({
  topicId,
  currentUser,
  profile,
  characters,
  authorStats,
  isUserOnline,
  hasPermission,
  PERMISSIONS,
  setReplyContent,
  replyRef,
  scrollToReply,
  _lang,
}) => {
  const stripQuotes = useCallback((text) => {
    if (!text) return '';
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
  }, []);

  const getLiveAuthorDisplayName = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === currentUser?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author?.character_id || c.name === post.author?.display_name);
        return char?.name || post.author?.display_name;
      }
      return profile?.nickname || post.author?.display_name;
    }
    if (post.is_character) return post.author?.display_name;
    return authorStats[post.author?.user_id]?.nickname || post.author?.display_name;
  }, [currentUser, profile, characters, authorStats]);

  /** Возвращает ник реального владельца аккаунта (а не имя маски) для тултипа бейджа персонажа. */
  const getLivePlayerOwnerName = useCallback((post) => {
    if (!post) return '';
    // 1. Прямое поле от бэкенда при маскировании (сервер пишет owner_name в AuthorRef DTO)
    if (post.author?.owner_name) return post.author.owner_name;
    // 2. Автор — учётная запись без маски: nickname / display_name аккаунта
    if (post.author?.user_id && post.author?.display_name && !post.author?.is_character) {
      return post.author.display_name;
    }
    return '';
  }, []);

  const getLiveAuthorStatus = useCallback((post) => {
    if (!post) return '';
    // The posts payload carries the resolved status in the AuthorRef DTO
    // (the backend bakes it at read time from the same character/account
    // record the old per-character fetch read) — so the card renders its
    // final height on first paint and no separate mask request is needed.
    return post.author?.status_line || '';
  }, []);
  const getLiveAuthorSignature = useCallback((post) => {
    if (!post) return '';
    // Same as the status above: the DTO carries the resolved signature.
    return post.author?.signature || '';
  }, []);

  const isAuthorOnline = useCallback((post) => {
    if (!post?.author?.user_id) return false;
    if (post.author?.user_id === currentUser?.uid) return true;
    return isUserOnline(post.author?.user_id);
  }, [currentUser, isUserOnline]);

  const getRoleBadge = useCallback((post, extraClass = '') => {
    if (post.is_character) {
      return (
        <div className={`${extraClass} post-author__role-wrapper`}>
          <ForumCharacterBadge ownerName={getLivePlayerOwnerName(post)} />
        </div>
      );
    }
    if (!post.author?.user_id) {
      return <ForumRoleBadge roleId="guest" className={extraClass} />;
    }
    const authorData = post.author?.user_id === currentUser?.uid ? profile : authorStats[post.author?.user_id];
    if (authorData === undefined) {
      return <div className={`skeleton skeleton-badge ${extraClass}`}></div>;
    }
    return (
      <ForumRoleBadge
        // the server AuthorRef DTO carries no role; the badge resolves from the
        // authorStats row (or the viewer's own profile) only.
        roleId={authorData?.role}
        status={authorData?.status}
        userEmail={authorData?.email}
        isDeleted={authorData === null || post.author?.deleted === true || post.author?.deleted === true}
        className={extraClass}
      />
    );
  }, [currentUser, profile, authorStats, getLivePlayerOwnerName]);

  const canDeletePost = useCallback((post) => {
    if (!currentUser || !post) return false;
    if (post.is_draft) return true;
    const authorId = post.author?.user_id || post.author?.user_id;
    if (authorId === currentUser.uid) {
      return hasPermission(PERMISSIONS.DELETE_SELF_POST);
    }
    return hasPermission(PERMISSIONS.DELETE_OTHERS_POSTS);
  }, [currentUser, hasPermission, PERMISSIONS]);

  const canEditPost = useCallback((post) => {
    if (!currentUser || !post) return false;
    if (post.is_draft) return true;
    const authorId = post.author?.user_id || post.author?.user_id;
    if (authorId === currentUser.uid) return true;
    return hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS);
  }, [currentUser, hasPermission, PERMISSIONS]);

  const handleQuote = useCallback((post) => {
    const selectedText = window.getSelection().toString().trim();
    const author = getLiveAuthorDisplayName(post) || post.author?.display_name || 'User';
    let content = selectedText || post.content;

    if (post.rolls) {
      content = content.replace(/\[roll=([a-z0-9_]+)\]/gi, (match, rId) => {
        const r = post.rolls[rId];
        if (r) {
          // The stored throw shape is {id, sides, value, type} — value/sides,
          // not the nonexistent notation/total pair.
          return `[b]🎲 ${r.comment ? r.comment + ': ' : ''}${r.value} из ${r.sides}[/b]`;
        }
        return match;
      });
    }

    const cleanContent = stripQuotes(content);
    const quote = `[quote="#p${post.id},t${topicId},${author}"]\n${cleanContent}\n[/quote]\n`;

    setReplyContent((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
      return prev + separator + quote;
    });
    window.getSelection().removeAllRanges();
    scrollToReply(replyRef);
  }, [getLiveAuthorDisplayName, setReplyContent, replyRef, scrollToReply, topicId, stripQuotes]);

  const handleQuoteAuthor = useCallback((authorName) => {
    if (!authorName) return;
    setReplyContent((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
      return `${prev}${separator}[b]${authorName}[/b], `;
    });
    scrollToReply(replyRef);
  }, [setReplyContent, replyRef, scrollToReply]);

  return {
    getLiveAuthorDisplayName,
    getLivePlayerOwnerName,
    getLiveAuthorStatus,
    getLiveAuthorSignature,
    isAuthorOnline,
    getRoleBadge,
    canDeletePost,
    canEditPost,
    handleQuote,
    handleQuoteAuthor,
  };
};

export default useTopicPostAuth;
