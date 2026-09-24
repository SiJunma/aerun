// Package forum implements the framework-free domain rules and constants
// for topics, posts, categories, and forum moderation.
//
// It must never import PocketBase. The platform adapter
// (internal/platform/pocketbase) enforces these rules inside transactional
// commands (plan §4 Sprint 3).
package forum
