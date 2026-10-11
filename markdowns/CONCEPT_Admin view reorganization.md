# Prompt for AI Agent: Admin Navigation & Structural Refactoring

## Role
You are a Senior Full-Stack Developer & UI/UX Architect.

## Objective
Refactor the administrative panel navigation. Replace the current horizontal tabs (`Settings`, `Designs`, `Users`, `Roles`, `Categories`, `Audit Log`, etc.) with a scalable, responsive left sidebar layout[cite: 1, 2].

---

## Critical Requirements & Constraints

### 1. Preserve Existing Global Topbar
* **DO NOT** modify or replace the existing global Header / Topbar. It is fully functional.
* The new Sidebar layout must sit directly underneath the global Header and span the remaining viewport height.

### 2. Pure Structural Refactoring (No UI/Styling Redesign)
* **DO NOT** alter component styling (e.g., border-radius, card designs, typography, or color schemes)[cite: 1, 2].
* Focus strictly on architecture, layout hierarchy, responsive navigation, and permission checking.
* Existing admin pages (`Settings`, `Users`, `Categories`, etc.) must remain untouched inside their respective content containers.

### 3. Logical Grouping & Hierarchy in Sidebar
* Organize all existing and future admin sections into collapsible/accordion groups[cite: 2].
* Example structural hierarchy:
  * **User & Access Management:** `Users`, `Roles`[cite: 1].
  * **Forum Content:** `Categories`, `Designs`[cite: 1].
  * **System Configuration:** `General Settings`, `Audit Log`[cite: 1].

### 4. Permission-Based Dynamic Navigation (RBAC Integration)
* Filter the sidebar navigation items based on the authenticated user's permissions or roles[cite: 1].
* If a user lacks permission for a section (e.g., `Audit Log`), that item or empty parent category **must be hidden completely**[cite: 1].
* The sidebar configuration must consume the user's `permissions` array/object to dynamically compute visible routes.

### 5. Responsive Behavior & Mobile Readiness
* **Desktop (Large screens):** Fixed left sidebar below the topbar.
* **Tablet / Mobile (Small screens):**
  * Sidebar converts into an Off-canvas / Drawer component toggled via a hamburger button or overlay.
  * Must not break the layout or overflow the screen width.
  * Selecting a navigation link on mobile should automatically close the drawer.

---

## Technical Implementation Plan

1. **Navigation Config (`adminNavigationConfig.ts`):**
   Define a typed, declarative array representing the navigation tree:
   ```typescript
   export interface NavItem {
     title: string;
     path?: string;
     icon?: string;
     permission?: string; // Required permission key
     children?: NavItem[]; // Nested sub-menu items
   }