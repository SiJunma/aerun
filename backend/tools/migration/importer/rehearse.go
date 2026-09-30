package importer

// Rehearsal driver (Sprint 7 tasks 2/5): one deterministic pass over a staging
// ledger that produces every artefact the Definition of Done asks for — the
// per-record mapping table, the compatibility findings, the foreign-key verdict
// and the counter reconciliation — plus elapsed time so repeated rehearsals can
// be compared.
//
// Nothing here writes to PocketBase. The rehearsal proves that *two runs over
// the same export describe the same target state*, which is exactly what the
// sprint demands before any database is touched.

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"
)

// RehearsalResult is the full outcome of one pass over an export.
type RehearsalResult struct {
	// Ledger identity, echoed so a report can be tied back to its export.
	ProjectID string `json:"projectId"`
	Snapshot  string `json:"snapshot"`

	// Durations in milliseconds. Only load is I/O bound; plan is CPU work over
	// every record. Both are reported so a regression shows up in the log.
	LoadMillis  int64 `json:"loadMillis"`
	PlanMillis  int64 `json:"planMillis"`
	TotalMillis int64 `json:"totalMillis"`

	// Record counts per plan bucket, plus the cache-only collections that were
	// deliberately skipped (Sprint 7 task 3).
	RecordCounts map[string]int `json:"recordCounts"`
	Skipped      map[string]int `json:"skipped"`

	// MappingSize is the number of legacy records with a target id.
	MappingSize int `json:"mappingSize"`

	// ForeignKeyErrors is empty for a rehearsal that may proceed.
	ForeignKeyErrors []string `json:"foreignKeyErrors"`

	// Findings are the explainable differences (compat.go).
	Compatibility *Compatibility `json:"compatibility"`

	// CounterMismatches are cached-vs-recomputed counter differences, keyed by
	// "topic/<id>/posts_count" etc.
	CounterMismatches map[string]string `json:"counterMismatches"`

	// MappingDigest is the SHA-256 of the canonical mapping table bytes. Two
	// rehearsals of one export must print the same digest; that single value is
	// the DoD check.
	MappingDigest string `json:"mappingDigest"`

	// Roles reconciles the legacy roles collection against the target registry
	// (roles.go). Nil when the caller passed no system rows, which only happens
	// in unit tests.
	Roles *RolePlan `json:"roles,omitempty"`

	// GlobalSettings classifies the legacy `settings/global` document. These are
	// deployment configuration, not forum data: by owner decision they stay in
	// the process environment (PB_SETTINGS_*) and are never written to a
	// collection. The report exists so the values are carried across as env vars
	// deliberately rather than the collection disappearing silently.
	GlobalSettings []GlobalSettingRow `json:"globalSettings,omitempty"`
}

// Rehearse runs the full pipeline over a staging ledger (and, optionally, the
// official auth export) and returns the result plus the mapping table to
// persist. It fails only on input errors: FK violations and counter mismatches
// are *reported*, because their job is to be reviewed, not to abort a
// rehearsal.
//
// systemRoles is the compiled target registry (internal/auth). Passing it makes
// the rehearsal also reconcile the roles collection; pass nil to skip that step.
// allowedPermissions is the target permission vocabulary used to validate
// imported custom-role permissions; nil disables the vocabulary check.
func Rehearse(ledgerPath, authPath string, systemRoles []RoleRow, allowedPermissions []string, logger *slog.Logger) (*RehearsalResult, *MappingTable, error) {
	if logger == nil {
		logger = slog.Default()
	}
	started := time.Now()

	ledger, err := LoadStagingLedger(ledgerPath)
	if err != nil {
		return nil, nil, err
	}
	var auth *AuthExport
	if authPath != "" {
		if auth, err = LoadAuthExport(authPath); err != nil {
			return nil, nil, err
		}
	}
	loaded := time.Now()

	plan, err := BuildPlan(ledger, auth, logger)
	if err != nil {
		return nil, nil, err
	}
	planned := time.Now()

	mappings, err := BuildMappings(plan, ledger.ProjectID)
	if err != nil {
		return nil, nil, err
	}
	table := mappings.Table(ledger.ProjectID)
	payload, err := table.MarshalCanonical()
	if err != nil {
		return nil, nil, err
	}

	var roles *RolePlan
	if systemRoles != nil {
		if roles, err = BuildRolePlan(plan, systemRoles, allowedPermissions); err != nil {
			return nil, nil, err
		}
	}

	return &RehearsalResult{
		ProjectID:         ledger.ProjectID,
		Snapshot:          ledger.Snapshot,
		LoadMillis:        loaded.Sub(started).Milliseconds(),
		PlanMillis:        planned.Sub(loaded).Milliseconds(),
		TotalMillis:       time.Since(started).Milliseconds(),
		RecordCounts:      countPlanBuckets(plan),
		Skipped:           plan.Skipped,
		MappingSize:       mappings.Len(),
		ForeignKeyErrors:  ValidateForeignKeys(plan),
		Compatibility:     AuditPlan(plan),
		CounterMismatches: Reconcile(plan, RecomputeCounters(plan)),
		MappingDigest:     fmt.Sprintf("%x", sha256.Sum256(payload)),
		Roles:             roles,
		GlobalSettings:    ClassifyGlobalSettings(plan),
	}, table, nil
}

// MarshalCanonical returns the mapping table as sorted, indented JSON with a
// trailing newline. json.Marshal already sorts map keys, and Table().Entries()
// is sorted by (space, legacyID), so the bytes depend only on the data.
func (t *MappingTable) MarshalCanonical() ([]byte, error) {
	sortMappingEntries(t.Entries)
	payload, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode mapping table: %w", err)
	}
	return append(payload, '\n'), nil
}

// WriteReport serialises a result deterministically (sorted keys, no wall-clock
// timestamp inside the body) so two reports of the same export are
// byte-identical files that can be diffed directly. Durations vary per run and
// are therefore NOT written — the CLI prints them instead.
func WriteReport(result *RehearsalResult, path string) error {
	clone := *result
	clone.LoadMillis, clone.PlanMillis, clone.TotalMillis = 0, 0, 0
	payload, err := json.MarshalIndent(&clone, "", "  ")
	if err != nil {
		return fmt.Errorf("encode report: %w", err)
	}
	return WriteFileExclusive(path, append(payload, '\n'))
}

// WriteFileExclusive creates path, refusing to overwrite an existing file —
// the same discipline as the Node.js staging pipeline, so an artefact from an
// earlier rehearsal can never be clobbered by a later one. The payload is
// written with a single trailing newline.
func WriteFileExclusive(path string, payload []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	body := bytes.TrimRight(payload, "\n")
	if _, err := file.Write(body); err != nil {
		file.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		file.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	return file.Close()
}

// countPlanBuckets reports how many records landed in each plan bucket.
func countPlanBuckets(plan *ImportPlan) map[string]int {
	buckets := map[string]map[string]map[string]any{
		"users":           plan.Users,
		"category_groups": plan.CategoryGroups,
		"categories":      plan.Categories,
		"topics":          plan.Topics,
		"posts":           plan.Posts,
		"drafts":          plan.Drafts,
		"subscriptions":   plan.Subscriptions,
		"reputation_logs": plan.ReputationLogs,
		"audit_logs":      plan.AuditLogs,
		"notifications":   plan.Notifications,
		"dms":             plan.DMs,
		"dm_messages":     plan.DMMessages,
		"roles":           plan.Roles,
	}
	out := make(map[string]int, len(buckets))
	for name, bucket := range buckets {
		out[name] = len(bucket)
	}
	return out
}
