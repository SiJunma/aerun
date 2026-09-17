> **Current status (2026-09-17): INCOMPLETE, not runnable/production-ready.**
> Go/PocketBase will not be installed or run on this device by user request.
> The startup instructions below describe the intended behavior, not a verified
> working server. `pb.Start()` has no `serve` command, the listener config is not
> wired, and the custom comma-separated CORS header is invalid. Encryption key
> presence is checked but encryption is not wired; production absolute data paths
> are not enforced. Mail mode validation does not disable PB auth email routes.
> Versions, migrations and Go tests remain unverified; `go.sum` is absent.
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
  rejected; listener/origin management is finalized in the next sprint review
  after verifying PocketBase serve APIs against v0.40.4.
- Production mode requires `AERUN_ENCRYPTION_KEY`, absolute `AERUN_DATA_DIR`
  and explicit `AERUN_ALLOWED_ORIGINS`; missing values abort startup.
