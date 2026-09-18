# Command Execution Rule

To ensure reliability and transparency, the assistant should follow these guidelines when executing terminal commands:

1. **Ask for Permission**: Always ask the user to run terminal commands manually if they involve building, testing, or significant system changes.
2. **Provide the Exact Command**: Clearly state the exact command that the user should run.
3. **Wait for Results**: After the user runs the command, ask them to provide the output or confirm if it was successful before proceeding.
4. **Reasoning**: If the assistant believes it's better to run the command itself, it should first explain why and wait for explicit confirmation from the user.

## Verifying Backend Changes (CI report)

Backend work must not be judged by local results alone. `.github/workflows/backend.yml`
verifies every push touching `backend/**` on a clean Linux runner (gofmt,
`go build`, `go vet`, `go test`) and publishes a machine-readable outcome to the
`ci-report` branch of the same repository. The repository is private, so this
plain-git channel is the intended way to read CI results without tokens or API
access:

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

Interpreting the report (`schema: aerun-ci-report/1`):

- `checks` contains a key only for a step that ran **and** passed; a missing
  `gofmt`/`build`/`vet`/`test` key means that step failed or was skipped.
- `status` is the overall job status; `run_url` links to the full browser log.
- Only the latest run is stored (the branch is force-pushed to one commit), so
  fetch it after each push rather than relying on an older reading.
- The publish step uses `if: always()`, therefore failed runs produce a report
  as well — a missing report means the workflow itself never ran.

A red report blocks further work: fix the failing check, push again, and re-read
the report. Details: `BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md` §5 and
`backend/README.md`.
