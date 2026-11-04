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
  maskStats,
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

  const getLiveOwnerName = useCallback((post) => {
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

  const getLiveAuthorStatus = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === currentUser?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author?.character_id || c.name === post.author?.display_name);
        return char ? (char.status_line || '') : (post.author?.status_line || '');
      }
      return profile ? (profile.status_line || '') : (post.author?.status_line || '');
    }
    if (post.is_character) {
      if (post.author?.character_id) {
        const stats = maskStats[post.author?.character_id];
        if (stats && stats.status_line !== undefined) return stats.status_line || '';
        if (stats === null) return post.author?.status_line || '';
      }
      return post.author?.status_line || '';
    }
    if (!post.author?.user_id) return post.author?.status_line || '';
    const stats = authorStats[post.author?.user_id];
    if (stats?.status_line !== undefined && stats.status_line !== '') {
      return stats.status_line;
    }
    return post.author?.status_line || '';
  }, [currentUser, profile, characters, maskStats, authorStats]);
  const getLiveAuthorSignature = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === currentUser?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author?.character_id || c.name === post.author?.display_name);
        return char ? (char.signature || '') : (post.author?.signature || '');
      }
      return profile?.settings?.signature || post.author?.signature || '';
    }
    if (post.is_character) {
      if (post.author?.character_id && maskStats[post.author?.character_id]?.signature !== undefined) {
        return maskStats[post.author?.character_id].signature || '';
      }
      return post.author?.signature || '';
    }
    const stats = authorStats[post.author?.user_id];
    if (stats?.settings?.signature !== undefined && stats.settings.signature !== '') {
      return stats.settings.signature;
    }
    return post.author?.signature || '';
  }, [currentUser, profile, characters, maskStats, authorStats]);

  const isAuthorOnline = useCallback((post) => {
    if (!post?.author?.user_id) return false;
    if (post.author?.user_id === currentUser?.uid) return true;
    return isUserOnline(post.author?.user_id);
  }, [currentUser, isUserOnline]);

  const getRoleBadge = useCallback((post, extraClass = 'mb-2') => {
    if (post.is_character) {
      return (
        <div className={`mt-0 ${extraClass} text-center w-100`}>
          <ForumCharacterBadge ownerName={getLiveOwnerName(post)} />
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
  }, [currentUser, profile, authorStats, getLiveOwnerName]);

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
    const author = getLiveOwnerName(post) || post.author?.display_name || 'User';
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
  }, [getLiveOwnerName, setReplyContent, replyRef, scrollToReply, topicId, stripQuotes]);

  const handleQuoteAuthor = useCallback((authorName) => {
    if (!authorName) return;
    setReplyContent((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
      return `${prev}${separator}[b]${authorName}[/b], `;
    });
    scrollToReply(replyRef);
  }, [setReplyContent, replyRef, scrollToReply]);

  return {
    getLiveOwnerName,
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
