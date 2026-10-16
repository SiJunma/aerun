# 🚀 Aerun Forum Engine

> **A modern, lightweight, and highly customizable self-hosted forum engine built for text-based roleplay games (FRPG) and niche communities.**

[![Stack](https://img.shields.io/badge/Stack-Go%201.27%20%7C%20PocketBase%20%7C%20React%2019-blue)](#tech-stack)
[![License](https://img.shields.io/badge/License-MIT-green)](#license)

---

## 💡 The Story & Why Aerun Exists

I have been an active participant and administrator in text-based roleplay communities (FRPG) since 2009. For over a decade, thousands of roleplay forums have been forced to rely on outdated legacy engines like MyBB or hosted services like RusFF. 

To achieve basic functionality required for roleplaying, forum owners are forced to inject dozens of third-party JavaScript scripts. This leads to:
* 📉 **Severe performance degradation:** Pages load slowly, lag, and crash on modern mobile devices.
* 💸 **Subscription traps & paywalls:** Third-party script developers demand recurring fees for essential features processed on external servers.
* 📢 **Intrusive advertising:** Hosted solutions force forums to pay ransom fees just to remove banner ads.

**Aerun was created to solve this once and for all.** 

It combines my 15+ years of roleplay community experience with a modern, high-performance tech stack (**Go + PocketBase + React**). Aerun provides all essential roleplay tools — masks, dice, granular access controls, custom design sandboxes, and economy features — **native out of the box, zero ad-monetization, and zero third-party performance penalties.**

---

## ⚖️ Why Aerun? (Comparison)

While modern forum engines like **NodeBB** or **Discourse** are great for standard corporate communities, they fall short for niche roleplay communities (FRPG):

| Feature / Metric | Legacy Engines (MyBB / RusFF) | Modern Engines (NodeBB / Discourse) | 🚀 **Aerun** |
| :--- | :--- | :--- | :--- |
| **Resource Footprint** | Low, but bloated by JS | High (Node.js/Ruby + MongoDB/Redis) | **Ultra-Low** (Go + Single SQLite binary) |
| **RPG Mechanics** | Third-party JS scripts | Non-existent / Custom plugins required | **Native** (Masks, Dice, Economy in core) |
| **Theme Customization** | Fragile CSS overrides | Complex template systems | **Theme Sandbox** (Isolated Storybook-like preview) |
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
* **Node.js** >= 18.x
* **Go** >= 1.22

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SiJunma/aerun.git
   cd aerun

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the development server:**
   ```bash
   npm run dev
   ```

### License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.