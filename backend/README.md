> **Current status (2026-09-18): compiles, Go tests pass, NOT yet a working server.**
> Go 1.27.0 and PocketBase v0.40.4 are installed and verified on this machine:
> `go.sum` generated via `go mod tidy`; `go build ./...` and `go test ./...` pass
> (config, fresh-app migrations, platform adapter). Verified against the v0.40.4
> source: `pb.Start()` with no arguments bootstraps system tables, prints the CLI
> help (`serve`/`superuser`) and exits — no listener starts and app migrations do
> NOT run, because v0.40.4 calls `RunAllMigrations()` only inside the `serve`
> command. Until the entry point invokes serve programmatically, the run command
> below just prints help and `AERUN_LISTEN` stays informational. The custom
> comma-separated CORS header is still invalid; encryption is validated but not
> wired; production absolute data paths and no-mail behavior are not enforced.
> Mail mode validation does not disable PB auth email routes.
> See `tools/migration/README.md` for the independently tested Node tools.
> PocketBase imports are allowed in the platform adapter AND schema migrations,
> not in future domain packages. Correlation IDs/CI/domain APIs remain pending.


# Aerun backend (Go + PocketBase)

Isolated local-first replacement for the Firebase backend. Sprint 1 of
`BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md`: an empty folder must bootstrap a
healthy server with applied migrations and no production secrets.

## Layout

- `cmd/aerun` — process entry point; rejects command-line arguments on purpose,
  configuration comes only from environment variables (see `.env.example`).
- `internal/config` — deployment configuration parsing and validation, decoupled
  from PocketBase so production guardrails are testable without a database.
- `internal/platform/pocketbase` — the only package allowed to import the
  PocketBase framework. Domain packages (`auth`, `forum`, `messaging`,
  `notifications`, `audit`, `storage`) will be added beside it framework-free.
- `internal/migrations` — versioned schema migrations, append-only.

## Run locally (no secrets required)

PowerShell, from `backend/`:

```powershell
$env:AERUN_ENV='local'
$env:AERUN_LISTEN='127.0.0.1:8090'
go run ./cmd/aerun
```

> Note (2026-09-18): with the current entry point this prints the PocketBase CLI
> help and exits — no listener and no app migrations. Programmatic serve wiring
> is the pending review item (see `BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md`).

The process fails startup when command-line flags are used; this keeps one
configuration path between local and VPS deployments.

## Health check

```
GET http://127.0.0.1:8090/api/aerun/health
```

The application also verifies the endpoint itself after startup and logs the
health result with structured (JSON) fields including a correlation-ready env
context.

## Migrations

Migrations are embedded Go files in `internal/migrations`; PocketBase applies
new unapplied migrations automatically during startup. Never edit an applied
migration — add a new timestamped file. Manual migration commands are not
exposed by this entry point because it intentionally rejects command-line
arguments; if manual control is needed later, it will be added behind the same
environment-validated path.

## Current limitations

- Email delivery is deliberately disabled (`AERUN_MAIL_MODE=disabled`).
- Command-line flags (`--http`, `--origins`, `--dir`) are intentionally
  rejected. Verified on v0.40.4 source: `pb.Start()` without arguments does not
  start a listener and does not apply app migrations (`RunAllMigrations()` runs
  only inside the `serve` command, `cmd/serve.go`); programmatic serve wiring is
  finalized in the next sprint review.
- Production mode requires `AERUN_ENCRYPTION_KEY`, absolute `AERUN_DATA_DIR`
  and explicit `AERUN_ALLOWED_ORIGINS`; missing values abort startup.
