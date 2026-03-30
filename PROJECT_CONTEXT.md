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
            "email": "string",
            "nickname": "string",
            "avatar_url": "string",
            "status_line": "string",
            "role_id": "string (references roles.id, e.g., 'root', 'admin', 'player')",
            "previous_role_id": "string (stores role before ban)",
            "post_count": "number",
            "reputation": "number",
            "admin_message": "string (optional)",
            "settings": {
              "theme": "string",
              "language": "string",
              "member_view_style": "string"
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
              "description": "Keeps track of last read times for topics. Document 'topics' has the mapping.",
              "fields": {
                "[topic_id]": "timestamp | number"
              }
            },
            "drafts": {
              "description": "Unpublished posts. Document ID matches the topic ID.",
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
            "whitelistMode": "boolean",
            "requireApproval": "boolean",
            "registrationEnabled": "boolean",
            "adminNickname": "string",
            "bgLight": "string",
            "bgDark": "string",
            "bgNeutral": "string",
            "enableDice": "boolean",
            "enableCharacters": "boolean",
            "enableReputation": "boolean",
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
            "unread": "object (maps uid to unread count)"
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
          "description": "Tracks active anonymous users.",
          "fields": {
            "guest_id": "string",
            "last_seen": "serverTimestamp"
          }
        }
      }
    }
  },
  "react_contexts": {
    "AuthContext": {
      "path": "src/contexts/AuthProvider.jsx",
      "description": "Maintains user state, global settings, unread counts, and permission checks.",
      "state_keys": [
        "user", "profile", "settings", "loading", "readMap", "unreadTopicsCount", "isMarkingAllRead", "roles", "PERMISSIONS"
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
    "src/ api": "Firestore operations isolated from components. Subdivided by domain (forum.js, auth.js, admin.js).",
    "src/ assets": "Static media (images, svgs).",
    "src/ components": "React presentation and logic components (common UI elements, layout wrappers).",
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
      "reputation_logs": "Limit 50 entries when viewing recent reputations on profile.",
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
    ]
  },
  "authentication_and_security": {
    "providers": ["Google", "Email & Password"],
    "account_linking": "Users can link Google or Password methods in their profile under the Security tab. To link a password to an existing Google account, users can specify a new password.",
    "email_validation": "When registering via email, a localized verification link is sent. If a user signs in with an unverified email, AuthProvider passes an `emailUnverified` context flag. The `PendingPage` and layout banners adapt to enforce email verification, temporarily restricting forum access."
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

    // Active = authenticated + profile exists + role is not pending/banned
    function isActive() {
      return isSignedIn()
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && getUser().data.role_id != 'pending' 
        && getUser().data.role_id != 'banned';
    }

    function hasPermission(permission) {
      let roleId = getUser().data.role_id;
      return roleId == 'root' || 
        (exists(/databases/$(database)/documents/roles/$(roleId)) && 
         permission in get(/databases/$(database)/documents/roles/$(roleId)).data.permissions);
    }

    function canModerateContent() {
      return isSignedIn() && hasPermission('moderate_content');
    }

    function isTopicOpen(topicId) {
      return get(/databases/$(database)/documents/topics/$(topicId)).data.is_locked != true;
    }

    // --- Users ---
    match /users/{userId} {
      // Allow read for everyone in public mode (profiles are public)
      allow read: if true;
      allow create: if isSignedIn() && request.auth.uid == userId;
      // User can edit own profile; admin can edit anyone; any active user can bump post_count/reputation
      allow update: if (isSignedIn() && request.auth.uid == userId) || isAdmin()
        || (isActive() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['post_count', 'reputation', 'last_seen', 'last_selected_character_id']));
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
      allow read: if true;
      allow create, delete: if isAdmin();
      // Counter updates from any active user (including spectators: read-only views still trigger view counts)
      allow update: if isAdmin()
        || (isActive() && request.resource.data.diff(resource.data).affectedKeys()
          .hasAny(['topics_count', 'posts_count', 'last_post_at', 'last_post_author', 'last_post_author_id', 'last_post_author_avatar', 'last_post_topic_id', 'last_post_topic_title', 'last_post_is_character', 'last_post_author_character_id']));
    }

    // --- Topics ---
    match /topics/{topicId} {
      allow read: if true;
      // Active users can create topics (UI handles category-specific permissions)
      allow create: if isActive();
      // Author or admin can edit; view/counter bumps allowed for all active users
      allow update: if isAdmin()
        || (isActive() && (
          resource.data.author_id == request.auth.uid
          || request.resource.data.diff(resource.data).affectedKeys()
            .hasAny(['views', 'posts_count', 'last_post_at', 'last_post_author', 'last_post_author_id', 'last_post_author_avatar', 'last_post_is_character', 'last_post_author_character_id'])
        ));
      allow delete: if canModerateContent() || (isActive() && resource.data.author_id == request.auth.uid && isTopicOpen(topicId));
    }

    // --- Posts ---
    match /posts/{postId} {
      allow read: if true;
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
