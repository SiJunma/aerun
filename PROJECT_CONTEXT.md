# Project Context

This file serves as the master context for AI interaction, combining the current JSON schema of the Firestore database, global React contexts, global constants, and the active `firestore.rules` document.

## CURRENT_PROJECT_SCHEMA.json

```json
{
  "database": {
    "firestore": {
      "collections": {
        "users": {
          "description": "Registered users.",
          "fields": {
            "uid": "string (document ID)",
            "email": "not stored in public profile; Firebase Auth is canonical private source",
            "nickname": "string",
            "avatar_url": "string",
            "status_line": "string",
            "role_id": "string (references roles.id, e.g., 'root', 'admin', 'player')",
            "previous_role_id": "string (stores role before ban)",
            "status": "'pending' | 'active' | 'banned'",
            "post_count": "number",
            "topics_count": "number",
            "reputation": "number",
            "admin_message": "string (optional)",
            "settings": {
              "theme": "string",
              "language": "string",
              "member_view_style": "string",
              "postsPerPage": "number (optional)",
              "email_notifications": {
                "dms": "boolean (default true)",
                "topic_replies": "boolean (default true)"
              }
            },
            "created_at": "serverTimestamp",
            "last_seen": "serverTimestamp",
            "updated_at": "serverTimestamp"
          },
          "subcollections": {
            "characters": {
              "description": "User-created masks/characters.",
              "fields": {
                "name": "string",
                "avatar_url": "string",
                "created_at": "serverTimestamp",
                "updated_at": "serverTimestamp"
              }
            },
            "readmap": {
              "description": "Keeps track of last read times for topics. Document ID is 'topics', one field per topic. Entry format is POLYMORPHIC depending on how it was written: (a) legacy: plain Firestore Timestamp (no offset stored), (b) current: object { timestamp: Timestamp, offset: number } where offset is the 0-based global post index of the last read post. IMPORTANT: all consumers must normalize before comparing — use (entry?.timestamp || entry) to unwrap, then check .toMillis().",
              "fields": {
                "[topic_id]": "Firestore Timestamp | number | { timestamp: Firestore Timestamp, offset: number }"
              },
              "consumer_pattern": "const lastVisitValue = entry?.timestamp || entry; const lastVisitMs = lastVisitValue?.toMillis ? lastVisitValue.toMillis() : (lastVisitValue || 0);"
            },
            "drafts": {
              "description": "Unpublished posts. Document ID matches the topic ID. Note: Publishing is decoupled from large batch transactions to avoid Firestore rules read limits. Frontend handles post creation, notification, then deletes draft separately.",
              "fields": {
                "is_draft": "boolean (must be true)",
                "topic_id": "string (references topics.id)",
                "author_id": "string (references users.uid)",
                "author_name": "string",
                "content": "string",
                "created_at": "serverTimestamp"
              }
            }
          }
        },
        "roles": {
          "description": "Forum roles. Determines permissions.",
          "fields": {
            "name": "string",
            "color": "string",
            "permissions": "array of strings",
            "is_system": "boolean",
            "base_role_id": "string (references roles.id)",
            "created_at": "serverTimestamp",
            "updated_at": "serverTimestamp"
          }
        },
        "settings": {
          "description": "Global settings for the forum. Only 'global' document is used.",
          "fields": {
            "forumName": "string",
            "welcomeMessage": "string",
            "maintenanceMode": "boolean",
            "maintenanceMessage": { "en": "string", "ru": "string" },
            "showMaintenanceMessage": "boolean",
            "whitelistMode": "boolean (White Wall for Guests — guests only see the login page; no forum data, presence or stream subscriptions are loaded for them)",
            "requireApproval": "boolean",
            "registrationEnabled": "boolean",
            "adminNickname": "string",
            "bgLight": "string",
            "bgDark": "string",
            "bgNeutral": "string",
            "deletedAvatar": "string (host-agnostic /api/files reference to the admin-uploaded avatar shown for a REMOVED account; empty = neutral default). PocketBase-native on the forum_settings singleton (migration 1769400000), served on the public settings snapshot; uploaded via PUT /api/aerun/admin/settings/placeholder/deleted, cleared via PATCH /api/aerun/admin/settings {\"deletedAvatar\":\"\"}.",
            "guestAvatar": "string (same as deletedAvatar, for an anonymous GUEST; uploaded via .../placeholder/guest). Read by src/utils/identity.js (identityAvatar) and drawn identically in posts, last-post thumbnails and the DM inbox/chat.",
            "enableDice": "boolean",
            "enableCharacters": "boolean",
            "enableReputation": "boolean",
            "reputationStyle": "string ('both' or 'positive_only')",
            "created_at": "serverTimestamp"
          }
        },
        "category_groups": {
          "description": "Groups for organizing categories.",
          "fields": {
            "title": { "en": "string", "ru": "string" },
            "order": "number",
            "created_at": "serverTimestamp",
            "updated_at": "serverTimestamp"
          }
        },
        "categories": {
          "description": "Forum categories holding topics.",
          "fields": {
            "group_id": "string (references category_groups.id)",
            "title": { "en": "string", "ru": "string" },
            "permissions": "object (e.g., { 'view_forum': ['player'] })",
            "order": "number",
            "topics_count": "number",
            "posts_count": "number",
            "last_post_at": "serverTimestamp",
            "last_post_author": "string",
            "last_post_author_id": "string (references users.uid)",
            "last_post_author_avatar": "string",
            "last_post_topic_id": "string (references topics.id)",
            "last_post_topic_title": "string",
            "last_post_is_character": "boolean",
            "last_post_author_character_id": "string (references users.uid/characters.id)",
            "created_at": "serverTimestamp",
            "updated_at": "serverTimestamp"
          }
        },
        "topics": {
          "description": "Threads within categories.",
          "fields": {
            "category_id": "string (references categories.id)",
            "title": "string",
            "description": "string",
            "author_id": "string (references users.uid)",
            "author_name": "string",
            "author_avatar": "string",
            "is_character": "boolean",
            "author_character_id": "string (references users.uid/characters.id)",
            "is_pinned": "boolean",
            "is_locked": "boolean",
            "views": "number",
            "reputation": "number",
            "posts_count": "number",
            "last_post_at": "serverTimestamp",
            "last_post_author": "string",
            "last_post_author_id": "string (references users.uid)",
            "last_post_author_avatar": "string",
            "last_post_is_character": "boolean",
            "last_post_author_character_id": "string (references users.uid/characters.id)",
            "created_at": "serverTimestamp",
            "updated_at": "serverTimestamp"
          }
        },
        "posts": {
          "description": "Individual replies within topics. Logic: Authors can delete their own post unless the topic is locked. Admin/Moderator can delete any.",
          "fields": {
            "topic_id": "string (references topics.id)",
            "author_id": "string (references users.uid)",
            "author_name": "string",
            "author_avatar": "string",
            "is_character": "boolean",
            "author_character_id": "string (references users.uid/characters.id)",
            "content": "string (can contain BBCode)",
            "rolls": "array of objects (dice roll results)",
            "reputation": "number",
            "is_draft": "boolean (false)",
            "edited_at": "serverTimestamp",
            "created_at": "serverTimestamp"
          }
        },
        "topic_subscriptions": {
          "description": "Users tracking topics for notifications.",
          "fields": {
            "topic_id": "string (references topics.id)",
            "user_id": "string (references users.uid)",
            "created_at": "serverTimestamp"
          }
        },
        "reputation_logs": {
          "description": "Reputation votes for posts or user profiles. Logic: Voting for banned or pending users is strictly blocked. Spectators can vote if permitted by UI.",
          "fields": {
            "voter_id": "string (references users.uid)",
            "voter_nickname": "string",
            "target_id": "string (references users.uid)",
            "post_id": "string (references posts.id, null for profile votes)",
            "topic_id": "string (references topics.id, null for profile votes)",
            "topic_title": "string",
            "post_number": "number",
            "value": "number",
            "comment": "string",
            "created_at": "serverTimestamp"
          }
        },
        "notifications": {
          "description": "System or user notifications.",
          "fields": {
            "recipient_uid": "string (references users.uid, null for global/admin broadcast)",
            "type": "string ('new_registration', 'topic_reply', 'reputation_change', etc.)",
            "read": "boolean",
            "archived": "boolean",
            "payload": {
              "topic_id": "string (optional)",
              "topic_title": "string (optional)",
              "first_post_id": "string (optional)",
              "last_post_id": "string (optional)",
              "post_count": "number (optional, for grouping)",
              "value": "number (optional, for reputation)",
              "voter_nickname": "string (optional, for reputation)",
              "admin_message": "string (optional)"
            },
            "created_at": "serverTimestamp"
          }
        },
        "dms": {
          "description": "Direct conversation headers between players.",
          "fields": {
            "participants": "array of strings (references users.uid)",
            "participantNames": "object (maps uid to nickname)",
            "participantAvatars": "object (maps uid to avatar_url)",
            "lastMessage": "string",
            "lastTimestamp": "serverTimestamp",
            "unread": "object (maps uid to unread count)",
            "clearedAt": "object (maps uid to timestamp of when the user deleted the dialog, hiding messages prior to this time)"
          },
          "subcollections": {
            "messages": {
              "fields": {
                "sender_uid": "string (references users.uid)",
                "text": "string (can contain BBCode)",
                "rolls": "array of objects",
                "timestamp": "serverTimestamp"
              }
            }
          }
        },
        "audit_logs": {
          "description": "Log of admin limits and actions.",
          "fields": {
            "action_type": "string",
            "performer_id": "string (references users.uid)",
            "details": "object (flexible payload)",
            "created_at": "serverTimestamp"
          }
        },
        "guest_activity": {
          "description": "DEPRECATED: Firestore guest tracking. Replaced by RTDB guest_presence to eliminate document write costs.",
          "fields": {
            "guest_id": "string",
            "last_seen": "serverTimestamp"
          }
        }
      }
    },
    "rtdb": {
      "nodes": {
        "guest_presence": {
          "description": "Real-time presence tracking for anonymous/guest sessions with onDisconnect removal (0 Firestore reads/writes).",
          "fields": {
            "$guestId": {
              "id": "string",
              "last_seen": "number (serverTimestamp ms)"
            }
          }
        },
        "status": {
          "description": "Live presence tracking node. Presence in 'Online now' is based on a 15-minute sliding window from last activity (unless explicitly in 'logged_out' state).",
          "fields": {
            "$uid": {
              "state": "string ('online' | 'offline' | 'logged_out')",
              "uid": "string",
              "nickname": "string",
              "avatar_url": "string",
              "role_id": "string",
              "post_count": "number",
              "status_line": "string",
              "signature": "string",
              "active_character": "object (null or { id, name, avatar_url })",
              "last_seen": "number (serverTimestamp ms)",
              "last_activity": "number (serverTimestamp ms, persistent visit timestamp)"
            }
          }
        },
        "notifications": {
          "description": "Per-user real-time notification node (instant push without Firestore read costs).",
          "fields": {
            "$uid": {
              "$notifId": {
                "id": "string",
                "type": "string",
                "read": "boolean",
                "payload": "object",
                "created_at": "number (ms)"
              }
            }
          }
        },
        "admin_notifications": {
          "description": "Real-time admin alert stream (registrations, reports). Readable only by admin/root; browser writes are denied and routed through manageAdminNotifications.",
          "fields": {
            "$notifId": {
              "id": "string",
              "type": "string",
              "read": "boolean",
              "payload": "object",
              "created_at": "number (ms)"
            }
          }
        },
        "dm_unread": {
          "description": "Real-time unread DM counts and conversation highlights.",
          "fields": {
            "$uid": {
              "total": "number",
              "conversations": {
                "$convId": {
                  "unread_count": "number",
                  "last_message": "string",
                  "sender_uid": "string",
                  "timestamp": "number (ms)"
                }
              }
            }
          }
        },
        "main_page_cache": {
          "description": "Server-only cache of category metadata, global statistics, and latest topics. Browser clients have no direct read or write access; getSecuredMainPageData filters category/topic data against current Firestore permissions before returning it.",
          "fields": {
            "categories": "object (maps catId to full category metadata and last_post_* info)",
            "stats": "object (total_topics, total_posts, total_users, newest_user_*, updated_at)",
            "latest_topics": "object (maps topicId to latest topic metadata for live unread updates and new-replies feed)"
          }
        },
        "topic_posts_cache": {
          "description": "Server-only cache of the last 3 pages of active topics (<24h activity), read only by getSecuredPosts after its permission check.",
          "fields": {
            "$topicId": {
              "meta": "object (category_id, cache_size, last_post_at, posts_count)",
              "posts": "object (maps postId to post payload)"
            }
          }
        },
        "session_perms": {
          "description": "Legacy RTDB permission-cache records. Security-critical filtering now reads roles, categories, and settings freshly from Firestore in each callable invocation.",
          "fields": {
            "$uid": "object (allowed_category_ids: array, role_id: string, expires_at: number)"
          }
        }
      }
    }
  },
  "react_contexts": {
    "AuthContext": {
      "path": "src/contexts/AuthProvider.jsx",
      "description": "Maintains user state, global settings, unread counts, and permission checks. After forum mutations it refreshes the server-filtered main-page projection immediately and with short retries, because Firestore triggers complete asynchronously.",
      "state_keys": [
        "user", "profile", "settings", "loading", "forumStateLoading", "forumStateError", "readMap (polymorphic — see readmap schema)", "unreadTopicsCount", "isMarkingAllRead", "roles", "PERMISSIONS"
      ]
    },
    "ToastContext": {
      "path": "src/contexts/ToastProvider.jsx",
      "description": "Global context for pushing flash notifications/toasts onto the screen."
    },
    "ThemeContext": {
      "path": "src/contexts/ThemeProvider.jsx",
      "description": "Manages global theme (light, dark, neutral, etc)."
    },
    "I18nContext": {
      "path": "src/contexts/I18nProvider.jsx",
      "description": "Internationalization. Manages switching between app languages (en/ru)."
    }
  },
  "folder_structure": {
    "src/ api": "Firestore operations isolated from components. Subdivided by domain (forum.js, auth-resources.js, categories.js, admin.js, etc.).",
    "src/ assets": "Static media (images, svgs).",
    "src/ components": "React presentation and logic components (common UI elements, layout wrappers).",
    "src/ config": "Global configuration files, such as smiles.js for animated emojis.",
    "src/ constants": "Hardcoded values, role definitions (e.g. permissions.js).",
    "src/ contexts": "React context providers (Auth, Theme, Toast, I18n).",
    "src/ i18n": "Translation messages/dictionaries.",
    "src/ pages": "Route-level functional components representing views.",
    "src/ styles": "Modular or extra CSS (global CSS is in index.css).",
    "src/ utils": "Helper functions for parsing bbcode, processing dice rolls, formatting dates."
  },
  "global_constants": {
    "IDLE_TIMEOUT_MS": "15 * 60 * 1000 (15 minutes of inactivity required before ceasing last_seen updates)",
    "TICK_MS": "2 * 60 * 1000 (Last observed threshold for pushing last_seen state locally)",
    "GUEST_TICK_MS": "10 * 60 * 1000 (Guest pulse for online visibility limit)",
    "Pagination Limits": {
      "dms": "Limit 50 conversations, messages fetched using dynamic limitCount.",
      "reputation_logs": "Server-side pagination via Cloud Function getReputationLogs. Uses Firestore count() for totalCount, offset+limit for paging. Default pageSize=20. Logs for inaccessible/deleted topics are included but have isAllowed=false (topic_title and post_id stripped). post_voters is a server-only RTDB cache; getPostVoters enforces category visibility before returning data.",
      "getUserPosts": "Server-side pagination via Cloud Function getUserPosts. Uses Firestore count() for totalCount, offset+limit for paging. Default pageSize=10. Posts in inaccessible categories are excluded.",
      "audit_logs": "Default 50 entries fetched per batch."
    },
    "CHIEF_ADMIN_ID": "'root' (Absolute highest privilege role identifier overriable by VITE_ADMIN_EMAIL from .env)",
    "Role Default Constants": [
      "'admin'",
      "'moderator'",
      "'player'",
      "'spectator'",
      "'guest'",
      "'pending'",
      "'banned'"
    ],
    "Guest Role Note": "The 'guest' role is a REAL Firestore document in the 'roles' collection. It is used as the effectiveRole for unauthenticated (non-logged-in) users in Cloud Functions (getReputationLogs, getUserPosts). Do NOT substitute 'spectator' for 'guest' — they have different permission sets."
  },
  "authentication_and_security": {
    "providers": ["Google", "Email & Password"],
    "account_linking": "Users can link Google or Password methods in their profile under the Security tab. To link a password to an existing Google account, users can specify a new password.",
    "email_validation": "When registering via email, a localized verification link is sent. If a user signs in with an unverified email, AuthProvider passes an `emailUnverified` context flag. The `PendingPage` and layout banners adapt to enforce email verification, temporarily restricting forum access."
  },
  "cloud_triggers": {
    "posts": {
      "onPostCreated": "Updates topic/category post counts and last_post metadata.",
      "onPostDeleted": "Decrements topic/category post counts and recalculates last_post metadata.",
      "onPostUpdated": "Detects author metadata changes (nickname, avatar, mask). If the updated post is the latest in its topic, triggers metadata sync for topic and category to ensure 'Last Message' info remains accurate.",
      "onUserUpdated/onCharacterUpdated": "When nickname, mask name, or avatar changes, refreshes the denormalized last-post identity in matching topics and categories. Topic deletion is fully server-owned: it performs the aggregate decrement and cascade deletion, while cascade post deletions do not decrement a second time."
    }
  },
  "ux_patterns": {
    "navigation": "App-wide ScrollToTop component ensures instant scroll to top on pathname changes (route transitions). Does not trigger on search parameter changes (pagination).",
    "skeleton_loading": "TopicPage uses granular loading states (topicReady, postsReady) and resets local state on ID change to ensure skeleton persists until all critical data is fetched, preventing layout shifts or empty state flashes."
  }
}
```

## firestore.rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper functions
    function isSignedIn() {
      return request.auth != null;
    }
    
    function isOwner(userId) {
      return isSignedIn() && request.auth.uid == userId;
    }
    
    function getUser() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid));
    }

    function isAdmin() {
      return isSignedIn() 
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && (getUser().data.role_id == 'admin' || getUser().data.role_id == 'root');
    }

    function getRole() {
      return !isSignedIn() ? 'guest' : 
        ('role_id' in request.auth.token ? request.auth.token.role_id : 
         (exists(/databases/$(database)/documents/users/$(request.auth.uid)) ? getUser().data.get('role_id', 'player') : 'player'));
    }

    function isAdmin() {
      return isSignedIn() && (getRole() == 'admin' || getRole() == 'root');
    }

    function isActive() {
      return isSignedIn() && getRole() != 'pending' && getRole() != 'banned';
    }

    function hasPermission(permission) {
      let roleId = getRole();
      return roleId == 'root' || 
        (exists(/databases/$(database)/documents/roles/$(roleId)) && 
         permission in get(/databases/$(database)/documents/roles/$(roleId)).data.permissions);
    }

    function isBanned() {
      return isSignedIn() && exists(/databases/$(database)/documents/users/$(request.auth.uid)) && getUser().data.role_id == 'banned';
    }

    function isPending() {
      return isSignedIn() && exists(/databases/$(database)/documents/users/$(request.auth.uid)) && getUser().data.role_id == 'pending';
    }

    function hasCategoryPermission(catId, permission) {
      let role = getRole();
      let catPerms = get(/databases/$(database)/documents/categories/$(catId)).data.permissions;
      // If the permission is not set at category level → fall back to global role check
      // (mirrors frontend hasPermission() fallback, where missing catPerm = use role default)
      return !(permission in catPerms)
        ? (isSignedIn() && hasPermission(permission))
        : (role in catPerms[permission]);
    }

    function canCreateTopic(catId) {
      return (isActive() || !isSignedIn()) && !isBanned() && !isPending() && hasCategoryPermission(catId, 'create_topic');
    }

    function canPostToTopic(topicId) {
      let tData = getTopicData(topicId);
      return (isActive() || !isSignedIn()) && !isBanned() && !isPending() && 
             hasCategoryPermission(tData.category_id, 'post_reply') && 
             (!('is_locked' in tData) || tData.is_locked == false) &&
             (tData.posts_count < 1000);
    }

    // --- Users ---
    match /users/{userId} {
      // Allow read for everyone in public mode (profiles are public)
      allow read: if true;
      allow create: if isSignedIn() && request.auth.uid == userId;
      // User can edit own profile (except protected fields); admin can edit anyone; 
      // reputation and post_count are now server-side only (Cloud Functions)
      allow update: if (isSignedIn() && request.auth.uid == userId && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role_id', 'post_count', 'reputation', 'join_date'])) || isAdmin()
        || (isActive() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['last_seen', 'last_selected_character_id']));
      allow delete: if isAdmin(); // Added to allow rejecting pending users
    }

    // --- Characters ---
    // Spectators cannot create characters
    match /characters/{charId} {
      allow read: if true;
      allow create: if isActive() && (request.resource.data.owner_id == request.auth.uid || isAdmin());
      allow update, delete: if isActive() && (resource.data.owner_id == request.auth.uid || isAdmin());
    }

    // --- User sub-collection characters ---
    match /users/{userId}/characters/{charId} {
      allow read: if true;
      allow create: if (isActive() && isOwner(userId)) || isAdmin();
      allow update, delete: if (isOwner(userId) && isActive()) || isAdmin();
    }

    // --- Category Groups ---
    match /category_groups/{groupId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    // --- Categories ---
    match /categories/{catId} {
      allow get: if isAdmin() || resource == null || hasCategoryDataPermission(resource.data, 'view_forum');
      allow list: if isAdmin();
      allow create, delete: if isAdmin();
      // All category counters and metadata are now written by Cloud Functions (Admin SDK).
      // No client path needs to update a category document.
      allow update: if isAdmin();
    }

    // --- Topics ---
    match /topics/{topicId} {
      allow get: if isAdmin() || resource == null || hasCategoryPermission(resource.data.category_id, 'view_forum');
      allow list: if isAdmin() || hasCategoryPermission(resource.data.category_id, 'view_forum');

      allow create: if (isAdmin() || canCreateTopic(request.resource.data.category_id))
        && (!isSignedIn() || request.resource.data.author_id == request.auth.uid)
        && request.resource.data.created_at == request.time;

      // Author may only edit content — not moderation flags, counters or ownership.
      allow update: if isAdmin() || canModerateContent()
        || (isActive() && resource.data.author_id == request.auth.uid
            && request.resource.data.diff(resource.data).affectedKeys()
                 .hasOnly(['title', 'content', 'updated_at', 'edited_at', 'edited_by', 'tags']))
        || ((isActive() || !isSignedIn())
            && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['views'])
            && request.resource.data.views == resource.data.views + 1);

      allow delete: if canModerateContent() || (isActive() && resource.data.author_id == request.auth.uid && isTopicOpen(topicId));
    }

    // --- Posts ---
     match /posts/{postId} {
      allow read: if isAdmin() || resource == null || hasCategoryPermission(resource.data.category_id, 'view_forum');
      // Active users can create posts; limit to 1000 posts per topic
      allow create: if isActive() && (
        !exists(/databases/$(database)/documents/topics/$(request.resource.data.topic_id)) ||
        get(/databases/$(database)/documents/topics/$(request.resource.data.topic_id)).data.posts_count < 1000
      );
      allow update: if isAdmin()
        || (isActive() && (
          resource.data.author_id == request.auth.uid
          || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['reputation'])
        ));
      allow delete: if canModerateContent() || (isActive() && resource.data.author_id == request.auth.uid && isTopicOpen(resource.data.topic_id));
    }

    // --- Drafts (Isolated per user/topic) ---
    match /users/{userId}/drafts/{topicId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // --- Read Map (tracks last topic visit per user, synced across devices) ---
    match /users/{userId}/readmap/{docId} {
      allow read, write: if isSignedIn() && request.auth.uid == userId;
    }

    // --- Global Settings ---
    match /settings/{docId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    // --- Global Stats ---
    match /global_stats/{docId} {
      allow read: if true;
      allow write: if isSignedIn();
    }

    // --- Reputation Logs ---
    match /reputation_logs/{logId} {
      // Users can read logs (UI filters based on settings)
      allow read: if true;
      // Any active user can vote (permissions defined by frontend); voter_id must match; cannot vote for self
      allow create: if isActive() 
        && request.resource.data.voter_id == request.auth.uid
        && request.resource.data.target_id != request.auth.uid
        && get(/databases/$(database)/documents/users/$(request.resource.data.target_id)).data.role_id != 'banned'
        && get(/databases/$(database)/documents/users/$(request.resource.data.target_id)).data.role_id != 'pending';
      // Logs are immutable except for admins and moderators
      allow update: if isAdmin();
      allow delete: if isAdmin()
        || (isSignedIn()
          && exists(/databases/$(database)/documents/users/$(request.auth.uid))
          && getUser().data.role_id == 'moderator');
    }

    // --- Audit Logs ---
    match /audit_logs/{logId} {
      allow create: if isSignedIn();
      allow read: if isSignedIn() 
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && getUser().data.role_id in ['admin', 'root', 'moderator'];
      allow update, delete: if isAdmin();
    }

    // --- Notifications ---
    // Any signed-in user can create (new registrants don't have 'active' status yet).
    // Personal notifications (recipient_uid = own uid) are readable by that user.
    // Admin-broadcast notifications (recipient_uid = null) are readable/manageable by admin only.
    match /notifications/{notifId} {
      allow create: if isSignedIn();
      allow read: if isAdmin()
        || (isActive() && (
             resource.data.recipient_uid == request.auth.uid || 
             (resource.data.type == 'topic_reply' && resource.data.read == false)
           ));
      allow update: if isAdmin()
        || (isActive() && (
             // Recipient can mark read/archive/etc
             (resource.data.recipient_uid == request.auth.uid && 
              request.resource.data.diff(resource.data).affectedKeys()
                .hasAny(['read', 'archived', 'payload', 'created_at']))
             ||
             // Other users can ONLY "merge" (update payload/timestamp) unread topic replies
             (resource.data.type == 'topic_reply' && resource.data.read == false && resource.data.archived == false &&
              request.resource.data.diff(resource.data).affectedKeys().hasOnly(['payload', 'created_at']))
           ));
      allow delete: if isAdmin();
    }

    // --- Topic Subscriptions ---
    match /topic_subscriptions/{subId} {
      allow read: if isActive();
      allow create: if isActive() && request.resource.data.user_id == request.auth.uid;
      allow delete: if isActive() && (resource.data.user_id == request.auth.uid || isAdmin());
    }

    // --- Roles ---
    match /roles/{roleId} {
      allow read: if true; // Allow reading for badge colors etc
      allow write: if isAdmin();
    }

    // --- Guest Activity (throttled unique guest tracking) ---
    match /guest_activity/{guestId} {
      allow read: if true;
      allow create: if true;
      allow update: if true;
      allow delete: if true;
    }

    // --- Direct Messages ---
    // Only active participants can read/write conversations and messages.
    match /dms/{convId} {
      // Allow read even if doc doesn't exist yet (resource == null for non-existent docs)
      allow read: if isActive() && (resource == null || request.auth.uid in resource.data.participants);
      allow create: if isActive() && request.auth.uid in request.resource.data.participants;
      allow update: if isActive() && request.auth.uid in resource.data.participants;

      match /messages/{msgId} {
        allow read: if isActive()
          && request.auth.uid in get(/databases/$(database)/documents/dms/$(convId)).data.participants;
        allow create: if isActive()
          && request.resource.data.sender_uid == request.auth.uid
          && request.auth.uid in get(/databases/$(database)/documents/dms/$(convId)).data.participants;
      }
    }
  }
}
```
