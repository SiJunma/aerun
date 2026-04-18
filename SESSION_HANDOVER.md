# Session Handover: Aerun Forum Architectural Hardening

**Date**: 2026-04-13
**Status**: Portions 1 & 2 Deployed 🚀

## 📋 Project State Summary
We are mid-refactor of the **Aerun Forum** architecture. The goal is to move sensitive logic (counters, reputation, notifications) from the client to server-side Cloud Functions for security and stability.

### Done & Deployed:
1.  **Security Rules**: Firestore rules now block client-side writes to `reputation`, `post_count`, `topics_count`, `posts_count`, and `last_post_*` fields.
2.  **Reputation System**: Migrated to server-side triggers (`onReputationLogCreated/Deleted`).
3.  **Forum Logic**: Migrated topic/post counters and "Last Post" metadata synchronization to server-side triggers (`onTopicCreated/Deleted`, `onPostCreated/Deleted`).
4.  **Notifications**: Topic reply and quote notifications are now handled automatically by the server.
5.  **API Cleanup**: Legacy client-side transaction logic has been removed from `src/api/forum.js` and `src/api/reputation.js`.
6.  **Privacy Hardening**: Fixed a data leak on the Profile Page where restricted posts/comments flickered during loading. Implemented "Skeleton-first" permission checks.

## 🛠️ Infrastructure Notes (Critical for Resume)
*   **Workflow**: We use the **"File System Operator"** pattern. The local agent is the "Hands", while the remote **MCP Cloud-Claude-Agent** is the "Architect".
*   **Remote Cleanup**: Mandatory `rm -rf /tmp/aerun_audit/` on the remote server after each task.
*   **Firebase CLI**: In this Windows environment, use the direct node path to avoid shell/permissions issues:
    `$env:FIREBASE_CLI_NO_USAGE=1; node .\node_modules\firebase-tools\lib\bin\firebase.js [command]`
*   **Deployment**: Always ensure `functions` are included in the deploy (now updated in `package.json`).

## ⏭️ Next Steps
1.  **Portion 3: Post Location Logic**: Standardize how the app finds and redirects to specific posts (e.g., when clicking a notification).
2.  **Audit**: Scan the rest of the `src/api/` directory for any remaining client-side `increment()` calls or metadata writes that should be locked down.
3.  **Staging Sync**: If needed, deploy the new architecture to the staging project (`aerun-test`), keeping in mind it might hit Cloud Functions invocation limits on the free tier.

---
*Good luck with the next session!*
