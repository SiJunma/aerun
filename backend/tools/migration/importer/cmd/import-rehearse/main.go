// Command import-rehearse runs one deterministic rehearsal of the migration
// against a local staging ledger, without touching any PocketBase database.
//
//	go run ./tools/migration/importer/cmd/import-rehearse \
//	    -ledger backend/migration-data/stage-1.json \
//	    -auth backend/migration-data/auth-official-2026-09-18.json \
//	    -out backend/migration-data/rehearsal-1
//
// It writes two artefacts, both exclusively created (never overwritten):
// mapping.json — the legacy -> PocketBase id table, and report.json — the
// duration-free reconciliation report. Sprint 7's Definition of Done is
// checked by running it twice into two output directories and diffing the
// artefacts: same export must yield the same target state. Elapsed time is
// printed to stdout only, because it varies per run by nature.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/tools/migration/importer"
)

// systemRoleRows adapts the compiled registry in internal/auth to the importer's
// transport type. The adapter lives here, in the command, so the importer
// package stays free of internal/* and of PocketBase: the reconciliation rule
// ("the compiled spec is authority, the export is only a reporter") then holds
// by construction rather than by convention.
func systemRoleRows() []importer.RoleRow {
	specs := auth.SystemRoles()
	rows := make([]importer.RoleRow, 0, len(specs))
	for _, spec := range specs {
		perms := auth.PermissionValues(spec.Permissions)
		// Sorted so the value depends only on the compiled matrix, never on
		// declaration order, keeping two rehearsals byte-identical.
		sort.Strings(perms)
		rows = append(rows, importer.RoleRow{
			RoleID:      string(spec.Role),
			Name:        spec.Name,
			Rank:        spec.Rank,
			Color:       spec.Color,
			IsSystem:    spec.IsSystem,
			Permissions: perms,
		})
	}
	return rows
}

// allowedPermissions is the compiled permission vocabulary every imported
// custom role is validated against; unenforceable permissions are dropped with
// a finding instead of being written into the registry.
func allowedPermissions() []string {
	perms := auth.AllPermissionValues()
	sort.Strings(perms)
	return perms
}

func main() {
	var (
		ledgerPath = flag.String("ledger", "", "staging ledger JSON (from cli.mjs stage)")
		authPath   = flag.String("auth", "", "official Firebase Auth export JSON (optional)")
		outDir     = flag.String("out", "", "output directory for mapping.json and report.json")
	)
	flag.Parse()

	if *ledgerPath == "" || *outDir == "" {
		fmt.Fprintln(os.Stderr, "usage: import-rehearse -ledger <stage.json> [-auth <auth.json>] -out <dir>")
		os.Exit(2)
	}
	if err := os.MkdirAll(*outDir, 0o700); err != nil {
		fail("create output directory", err)
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	result, table, err := importer.Rehearse(*ledgerPath, *authPath, systemRoleRows(), allowedPermissions(), logger)
	if err != nil {
		fail("rehearse", err)
	}

	if err := table.SaveTable(filepath.Join(*outDir, "mapping.json")); err != nil {
		fail("save mapping table", err)
	}
	if err := importer.WriteReport(result, filepath.Join(*outDir, "report.json")); err != nil {
		fail("save report", err)
	}

	fmt.Printf("project=%s snapshot=%s\n", result.ProjectID, result.Snapshot)
	fmt.Printf("records=%d mapped=%d skipped_cache=%d\n",
		sum(result.RecordCounts), result.MappingSize, sum(result.Skipped))
	fmt.Printf("timing load=%dms plan=%dms total=%dms\n",
		result.LoadMillis, result.PlanMillis, result.TotalMillis)
	fmt.Printf("mapping_digest=%s\n", result.MappingDigest)
	fmt.Printf("foreign_key_errors=%d counter_mismatches=%d findings=%d\n",
		len(result.ForeignKeyErrors), len(result.CounterMismatches), len(result.Compatibility.SortedFindings()))

	for _, line := range result.Compatibility.SortedFindings() {
		fmt.Printf("  finding %s\n", line)
	}
	for _, line := range result.Compatibility.SortedRoleDecisions() {
		fmt.Printf("  role %s\n", line)
	}
	for _, line := range result.ForeignKeyErrors {
		fmt.Printf("  FK %s\n", line)
	}
	for _, line := range sortedMismatchLines(result.CounterMismatches) {
		fmt.Printf("  mismatch %s\n", line)
	}
	if result.Roles != nil {
		printRoles(result.Roles)
	}
	printGlobalSettings(result.GlobalSettings)

	// A rehearsal with dangling foreign keys must not look like a success even
	// though every artefact was written for review.
	if len(result.ForeignKeyErrors) > 0 {
		os.Exit(1)
	}
}

// printGlobalSettings renders the settings/global handover list.
//
// The wording matters more than usual here. These values are NOT in the
// database and never will be — the owner decision keeps global forum settings in
// the process environment. So this block is the only place the values exist in
// reviewable form, and the `enforced_in_code` rows are called out explicitly:
// someone reading an env-var table that says `whitelistMode=false` must not
// conclude that registration is now a config switch.
func printGlobalSettings(rows []importer.GlobalSettingRow) {
	if len(rows) == 0 {
		return
	}
	fmt.Printf("global_settings: %d keys — NOT imported; set these as env vars\n", len(rows))
	for _, row := range rows {
		line := fmt.Sprintf("  %-30s %-22s %s", row.EnvVar, row.Class, row.Value)
		if row.Note != "" {
			line += "\n      ↳ " + row.Note
		}
		fmt.Println(line)
	}
}

func fail(what string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", what, err)
	os.Exit(1)
}

// printRoles reports the roles reconciliation: which registry rows the target
// must have, which legacy documents matched them, and which legacy custom roles
// are imported verbatim (with their holder counts).
func printRoles(roles *importer.RolePlan) {
	fmt.Printf("roles: target=%d legacy_system=%d legacy_custom=%d target_without_legacy=%d\n",
		len(roles.Rows), len(roles.LegacySystem), len(roles.LegacyCustom), len(roles.MissingSystem))
	for _, row := range roles.Rows {
		fmt.Printf("  registry %s rank=%d color=%s perms=%d %s\n",
			row.RoleID, row.Rank, row.Color, len(row.Permissions), row.Name)
	}
	for _, row := range roles.CustomRows {
		fmt.Printf("  imported_custom_role %s base=%s mask_limit=%d perms=%d users=%d %s\n",
			row.RoleID, row.BaseRoleID, row.MaxCharactersLimit, len(row.Permissions),
			roles.CustomRoleUsers[row.RoleID], row.Name)
	}
	for _, id := range roles.MissingSystem {
		fmt.Printf("  target_only_role %s\n", id)
	}
	for _, line := range importer.SortedFindings(roles.Findings) {
		fmt.Printf("  role_finding %s\n", line)
	}
}

func sum(m map[string]int) int {
	total := 0
	for _, v := range m {
		total += v
	}
	return total
}

// sortedMismatchLines renders counter mismatches in stable key order.
func sortedMismatchLines(m map[string]string) []string {
	lines := make([]string, 0, len(m))
	for key, value := range m {
		lines = append(lines, fmt.Sprintf("%s %s", key, value))
	}
	sort.Strings(lines)
	return lines
}
