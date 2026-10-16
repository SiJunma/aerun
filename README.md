# 🚀 Aerun Forum Engine

> **A modern, lightweight, and highly customizable self-hosted forum engine built for text-based roleplay games (FRPG) and niche communities.**

[![Stack](https://img.shields.io/badge/Stack-Go%201.27%20%7C%20PocketBase%20%7C%20React%2019-blue)](#tech-stack)
[![License](https://img.shields.io/badge/License-MIT-green)](#license)

---

## 💡 The Story & Why Aerun Exists

I have been an active participant and administrator in text-based roleplay communities (FRPG) since 2009. For over a decade, thousands of roleplay forums have been forced to rely on outdated legacy engines like MyBB or hosted services like RusFF. 

When looking at modern alternatives like Discourse, NodeBB, or Flarum, a major issue arises: **they no longer feel like classic forums.** Out of the box, they look like endless social media feeds or comment streams rather than structured, category-driven discussion spaces. Restoring a familiar, structured forum experience requires installing yet another layer of complex plugins.

On the other hand, sticking with legacy engines leads to severe bottlenecks:
* 📉 **Severe performance degradation:** To get basic roleplay features, owners inject dozens of third-party JavaScript scripts that cause lag and mobile crashes.
* 💸 **Subscription traps & paywalls:** Script developers demand recurring fees for essential features processed on external servers.
* 📢 **Intrusive advertising:** Hosted solutions force forums to pay ransom fees just to remove banner ads.

**Aerun was created to combine the best of both worlds.** 

It keeps the **familiar, structured, category-driven forum experience** that communities love, while powering it with a modern, high-performance tech stack (**Go + PocketBase + React**). Aerun provides all essential roleplay tools — masks, dice, granular access controls, custom design sandboxes, and economy features — **native out of the box, zero ad-monetization, and zero third-party performance penalties.**

---

## ⚖️ Why Aerun? (Comparison)

| Feature / Metric | Legacy Engines (MyBB / RusFF) | Modern Alternatives (NodeBB / Discourse / Flarum) | 🚀 **Aerun** |
| :--- | :--- | :--- | :--- |
| **UX & Layout** | Classic Forum Structure | Feed / Chat-like UX (Requires plugins for classic layout) | **Classic Forum Structure Native** |
| **Resource Footprint**| Low, but bloated by JS | High (Node.js/Ruby + MongoDB/Redis) | **Ultra-Low** (Go + Single SQLite binary) |
| **RPG Mechanics** | Third-party JS scripts | Non-existent / Custom plugins required | **Native** (Masks, Dice, Economy in core) |
| **Theme Customization**| Fragile CSS overrides | Complex template systems | **Theme Sandbox** (Isolated Storybook-like preview) |
| **Deployment** | Legacy PHP hosting | Heavy container setups | **One-Click CLI** / Single Executable |
| **Monetization** | Intrusive ads / Ransom fees | Varies | **100% Free & Open Source (MIT)** |

## ✨ Key Features

### 🎭 Roleplay & Social Mechanics
* **Character Masks:** Post seamlessly under multiple character personas with custom names, avatars, signatures, and statuses.
* **Built-in RPG Dice System:** Support for `d4` through `d100` rolls, including master/GM-only hidden dice rolls.
* **Rich BBCode & Media:** Advanced formatting, quotes, spoilers, tabbed/column layouts, color/font overrides, custom HTML/CSS blocks, and media embeds.
* **Hidden Content:** Restrict content visibility by specific user, minimum post count, or moderator role.
* **Reputation & Notifications:** Upvote/downvote system with private or public logs, instant in-app alerts, and customizable email templates.

### 🎨 Design & Customization (The Theme Sandbox)
* **Theme Sandbox / Storybook:** A dedicated isolated environment for theme developers. Preview custom CSS/JS designs across all components, accessibility states, and screen sizes without affecting live users.
* **Themeable DOM & Open Styling API:** Stable, semantic markup that doesn't break when updating engine versions.
* **Built-in Modes:** Light, Dark, Neutral, and custom admin-created themes.

### 🛡️ Granular Permissions & Security
* **Multi-Tiered Access Control:** Differentiated global, category-level, and topic-level permissions.
* **Server-Side Enforcement:** Every action (editing, deleting, viewing) is validated strictly on the server — not just hidden in the frontend UI.
* **Audit Logs & Moderation:** Full action history for administrators, soft-deletes with restore capabilities, registration pre-moderation, and maintenance mode.

---

## 🔮 Roadmap & Planned Features

* [ ] **Expanded Internationalization (i18n):** Community-driven translation support for additional languages beyond EN/RU.
* [ ] **Activity Analytics Dashboard:** Track post counts per category, user, and timeframe to automate weekly/monthly activity awards.
* [ ] **CLI Tool (`aerun-cli`):** One-click terminal installation, automated SQLite migrations, backups, and zero-downtime updates (`aerun update`).
* [ ] **In-Game Forum Economy:** Currency, banking system, automated rewards, badges, and an item shop.
* [ ] **Web Push Notifications:** Standalone PWA & browser notifications decoupled from third-party services.
* [ ] **Group Direct Messages:** Private multi-user group conversations.

---

## 🛠️ Tech Stack

### Frontend
* **Core:** React 19, React Router, Vite
* **UI & Styling:** React Bootstrap, Framer Motion (Animations), Lucide Icons
* **Integration:** PocketBase JavaScript SDK
* **Localization:** Native English & Russian interface with an extensible i18n architecture for future language additions

### Backend & Data
* **Engine:** Go 1.27
* **Database & BaaS:** PocketBase (SQLite core)
* **Communication:** SMTP mail queue, Server-Sent Events (Real-time updates with polling fallback)

---

## ⚙️ Getting Started (Local Development)

### Prerequisites
* **Node.js** 20.19+ or 22.12+
* **Go** 1.27+
* Git

PocketBase is compiled into the Go backend; it does not need to be installed
separately. A clean local launch also works without an `.env` file or any
secrets.

### Quick Start

1. **Clone the repository and install the frontend dependencies:**

   ```bash
   git clone https://github.com/SiJunma/aerun.git
   cd aerun
   npm ci
   ```

2. **Start the backend first.** Keep this terminal open. On Windows, run:

   ```powershell
   npm run dev:backend
   ```

   If PowerShell blocks `npm.ps1`, use `npm.cmd run dev:backend` instead.
   On macOS/Linux, run the backend directly:

   ```bash
   cd backend && go run ./cmd/aerun
   ```

   The server is ready when `http://127.0.0.1:8090/api/aerun/health` returns
   JSON with `"status": "ok"`. The first launch creates the local SQLite
   database in `backend/pb_data/` and prints a one-time PocketBase administrator
   setup URL; open that URL to create the first administrator account.

3. **In a second terminal, start the frontend from the repository root:**

   ```bash
   npm run dev
   ```

   In PowerShell with the same execution-policy issue, use `npm.cmd run dev`.

4. Open the address shown by Vite (normally
   [http://localhost:5173](http://localhost:5173)). The frontend uses the
   local backend at `http://127.0.0.1:8090` by default.

To stop the local backend on Windows, run `npm run dev:backend:stop`. For
deployment and operational commands, see [DEPLOY.md](DEPLOY.md).

### License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
