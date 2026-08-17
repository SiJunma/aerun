# Project Rules

- **Build and Deployment Workflow**: Do NOT run terminal commands to build or deploy the project (e.g. `npm run build`, `firebase deploy`). Perform all necessary code modifications, updates, and analysis, then provide a summary report to the user so the user can build and deploy manually.
- **RTDB-First Data Architecture**: Always prioritize Firebase Realtime Database (RTDB) for frequently updated or frequently queried dynamic data (presence statuses, unread notification counters, session permissions, active topic posts cache, main page cache and stats) to drastically minimize Firestore read/write costs, while keeping Firestore as the permanent source of truth.

