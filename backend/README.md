> **Current status (2026-09-18): local serve WIRED and verified end-to-end.**
> Go 1.27.0 + PocketBase v0.40.4 installed; `go build ./...`, `go vet ./...` and
> `go test ./...` pass. The entry point now bootstraps and serves
> programmatically via `apis.Serve` (migrations apply, health self-probe passes,
> graceful shutdown on Ctrl+C). Verified live on 127.0.0.1:8090: health JSON,
> `/_/` dashboard, PB CORS per-origin echo with allowlist enforcement (204
> preflight, no header for disallowed origins), `idempotency_keys` migration
> applied. First run opens/prints a superuser installer URL
> (`/_/#/pbinstall/<token>`, valid 30 min) — create your admin there.
> Remaining gaps: production absolute data paths and no-mail-route enforcement
> (Sprint 2 guardrail), dedicated read-only export identity (Sprint 8), domain
> APIs (auth/forum/messaging/…, Sprint 2+). CI (gofmt/build/vet/test) is wired
> in `.github/workflows/backend.yml`. Note: CLI arguments are rejected, so
> `superuser upsert` is unreachable; use the installer URL on a fresh `pb_data`
> (or delete `pb_data/` to regenerate it).
> See `tools/migration/README.md` for the independently tested Node tools.
> PocketBase imports are allowed in the platform adapter AND schema migrations,
> not in future domain packages. Domain APIs (auth/forum/messaging/…) remain
> pending (Sprint 2+).


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

> The listener is the validated loopback `AERUN_LISTEN`; the process serves
> until interrupted (Ctrl+C triggers a graceful shutdown).

The process fails startup when command-line flags are used; this keeps one
configuration path between local and VPS deployments.

## CI

GitHub Actions (`.github/workflows/backend.yml`) runs gofmt, `go build`,
`go vet` and `go test` on every push touching `backend/**`, on a clean Linux
runner with the Go version from `go.mod`. Each run also publishes a
machine-readable result to the `ci-report` branch (`report.json`); read it from
anywhere with plain git — no tokens or GitHub API access required, which matters
because this repository is private:

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

Report schema `aerun-ci-report/1`:

```json
{
  "schema": "aerun-ci-report/1",
  "run_number": 2,
  "status": "success",
  "branch": "feature/pocketbase-migration",
  "commit": "<full sha>",
  "checks": {"gofmt": "ok", "build": "ok", "vet": "ok", "test": "ok"},
  "run_url": "https://github.com/<owner>/<repo>/actions/runs/<id>",
  "finished_at": "2026-09-18T20:12:23Z"
}
```

How to read it: `checks` holds a key only for a step that ran and passed, so a
missing `gofmt`/`build`/`vet`/`test` key means that step failed or was skipped;
`status` is the overall job status. The publish step runs with `if: always()`,
so failing runs are reported too. The branch is force-pushed to a single commit,
so only the newest run is available there — use `run_url` (or the Actions tab)
for history. Treat the report as the authoritative external check: local results
come from a developer machine, the report comes from a clean checkout.

## Health check

```
GET http://127.0.0.1:8090/api/aerun/health
```

The application also verifies the endpoint itself after startup and logs the
health result with structured (JSON) fields including a correlation-ready env
context.

Every response carries an `X-Request-ID` header: a valid incoming ID is echoed
(max 64 chars, `[A-Za-z0-9_.:-]`), otherwise a fresh random ID is generated.
The same value is returned in the health body as `request_id` and is available
to handlers for structured-log correlation.

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
  rejected; all configuration comes from environment variables. The listener,
  migrations and CORS are wired programmatically through `apis.Serve` (verified
  against v0.40.4 source and live probes; `RunAllMigrations()` runs inside
  `apis.Serve` itself). Consequence: the built-in `superuser upsert`
  subcommand is unreachable — create the first superuser via the installer URL
  printed on first run with a fresh `pb_data/`.
- Production mode requires `AERUN_ENCRYPTION_KEY`, absolute `AERUN_DATA_DIR`
  and explicit `AERUN_ALLOWED_ORIGINS`; missing values abort startup.
