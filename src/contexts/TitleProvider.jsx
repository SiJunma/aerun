/* eslint-disable react-refresh/only-export-components, react-hooks/set-state-in-effect */
// set-state-in-effect: the guard below is an external subscription whose
// unsubscribed reset (a sign-out blanking the badge) is expressed as a state
// reset. It is not derived state — the counts only arrive asynchronously from
// the RTDB subscription — so resetting during render would fight the pending
// callback. Same call as I18nProvider's language sync.
import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { useI18n } from './I18nProvider';
import { useDesign } from './DesignProvider';
import { subscribeToUnreadCounts } from '../api/dms';

const TitleContext = createContext();

export const usePageTitle = () => useContext(TitleContext);

export const TitleProvider = ({ children }) => {
  const [pageTitle, setPageTitle] = useState('');
  const { user, profile, settings, hasPermission, PERMISSIONS, activeDmConvId, unreadTopicsCount } = useAuth();
  const { lang } = useI18n();
  const { activeDesign } = useDesign();

  // Real-time unread notifications and DMs subscription for browser tab title badge.
  //
  // The raw snapshot is held in state and the two badge numbers are DERIVED from
  // it during render, instead of being mirrored into more state by effects. The
  // previous shape kept the same snapshot in a ref and recomputed dmCount in two
  // places — the subscription callback and an [activeDmConvId] effect — each
  // reading a `_activeDmConvId` field hand-synced onto the ref, which is a
  // stale-closure trap. One source of truth, read directly, removes both the
  // trap and the cascading renders the effects caused.
  const [dmUnreadData, setDmUnreadData] = useState({ total: 0, conversations: {} });
  const [userCount, setUserCount] = useState(0);

  // Counts only mean anything for a signed-in member who is neither pending nor
  // banned. The guard is applied where the numbers are read rather than by an
  // effect resetting state on the way out, so a sign-out blanks the badge on the
  // very next render with no extra render pass.
  const countsEligible = Boolean(user?.uid)
    && profile?.role_id !== 'pending'
    && profile?.role_id !== 'banned';

  // The DM term excludes the conversation currently open in the UI: those
  // messages are already on screen, so counting them in the tab badge would
  // double-report them. `conversations` is empty when the member is not
  // eligible, which naturally yields dmCount 0.
  const { total = 0, conversations = {} } = countsEligible ? dmUnreadData : {};
  const dmCount = (activeDmConvId && conversations[activeDmConvId])
    ? Math.max(0, total - (conversations[activeDmConvId]?.unread_count || 0))
    : total;

  // Combine counts into unreadCount (notifications + DMs + new topics/posts)
  //
  // There is no separate admin term any more. The admin feed was the SAME
  // request as the member's own — `/me/notifications` is already scoped to the
  // caller server-side — so it polled the endpoint a second time and then ADDED
  // the identical rows, doubling both the tab badge and the sound that plays on
  // a new notification.
  const unreadCount = (countsEligible ? userCount : 0) + dmCount + (unreadTopicsCount || 0);

  // The tab title's notification term is the SERVER's count.
  //
  // It used to come from `subscribeToUserNotifications` — a
  // `GET /me/notifications?limit=100` whose hundred rows were counted in the
  // browser for one integer, on every page of the forum. `/me/unread-counts`
  // already returns `unread_notifications`, and this provider was already
  // subscribing to that resource for the DM term, so the two badges were reading
  // two endpoints to render one number that one of them already carried.
  useEffect(() => {
    if (!user?.uid || profile?.role_id === 'pending' || profile?.role_id === 'banned') {
      setUserCount(0);
      setDmUnreadData({ total: 0, conversations: {} });
      return;
    }

    let unsubDm = () => {};
    if (hasPermission && hasPermission(PERMISSIONS?.USE_DIRECT_MESSAGES)) {
      unsubDm = subscribeToUnreadCounts(user.uid, (data) => {
        const raw = data || { total: 0, conversations: {} };
        setDmUnreadData(raw);
        setUserCount(raw.notifications || 0);
      });
    } else {
      // No DM permission still leaves the notification badge real: the counters
      // response carries it, and gating the whole subscription on DMs would blank
      // the title number for a member who is allowed notifications but not DMs.
      unsubDm = subscribeToUnreadCounts(user.uid, (data) => {
        setUserCount((data || {}).notifications || 0);
      });
    }

    return () => {
      unsubDm();
    };
  }, [user?.uid, profile?.role_id, hasPermission, PERMISSIONS?.USE_DIRECT_MESSAGES]);

  useEffect(() => {
    let baseName = 'Forum';
    if (activeDesign?.forumTitle) {
      baseName = activeDesign.forumTitle;
    } else {
      const rawName = settings?.forumName;
      baseName =
        (typeof rawName === 'object' && rawName !== null)
          ? (rawName[lang] || rawName.ru || rawName.en || 'Forum')
          : (rawName || 'Forum');
    }

    const titleParts = [];
    if (unreadCount > 0) {
      titleParts.push(`(${unreadCount})`);
    }
    if (pageTitle) {
      titleParts.push(pageTitle);
    }
    titleParts.push(baseName);

    document.title = titleParts.join(' | ');

    // Handle Favicon update
    const updateFavicon = (count) => {
      let link = document.querySelector("link[rel*='icon']");
      if (!link) {
        link = document.createElement('link');
        link.type = 'image/jpeg';
        link.rel = 'shortcut icon';
        document.head.appendChild(link);
      }

      // THE BASE ICON IS THE ONE INDEX.HTML DECLARES: /favicon.jpg, a real
      // image. /favicon.ico used to be referenced here, but that file is a
      // ~750-byte stub next to the real 79KB jpg — swapping to it mid-load is
      // exactly the "favicon flashes then disappears" the site showed.
      const originalFaviconUrl = '/favicon.jpg';
      // Keep the link's declared type in step with the href: a stale
      // image/x-icon type makes some browsers reject the jpeg silently.
      link.type = 'image/jpeg';

      if (count > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.src = originalFaviconUrl;
        img.onload = () => {
          ctx.drawImage(img, 0, 0, 32, 32);
          
          // Draw badge circle
          ctx.beginPath();
          ctx.arc(22, 10, 9, 0, 2 * Math.PI);
          ctx.fillStyle = '#ff3b30'; // red badge
          ctx.fill();
          
          // Draw text
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 12px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(count > 9 ? '9+' : count.toString(), 22, 11);
          
          link.href = canvas.toDataURL('image/png');
        };
      } else {
        link.href = originalFaviconUrl;
      }
    };

    updateFavicon(unreadCount);

  }, [pageTitle, unreadCount, settings?.forumName, lang, activeDesign]);

  return (
    <TitleContext.Provider value={{ setPageTitle, unreadCount }}>
      {children}
    </TitleContext.Provider>
  );
};
