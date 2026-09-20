// Package auth is the framework-free identity domain: roles, statuses,
// permissions and nickname normalisation for the Aerun forum backend.
//
// It must never import PocketBase. The platform adapter
// (internal/platform/pocketbase) is the only place that translates stored
// records into these types, so the domain rules stay testable and portable.
//
// Sprint 2 of BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md: identity, RBAC and
// secure reads. The legacy application encoded "pending" and "banned" as
// role ids; the target contract separates them into account statuses, so the
// importer maps legacy role_id=pending/banned onto status instead of role.
package auth
