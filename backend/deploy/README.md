# Production deploy (VPS)

Target topology: Caddy (TLS) → static `dist/` + reverse proxy → Go/PocketBase
backend on `127.0.0.1:8090`, systemd unit, env-only configuration.

## Files

- `aerun.service` — systemd unit for the compiled binary
  (`/home/deploy/project/backend/aerun`), reads the process environment from
  `/home/deploy/project/.env` via `EnvironmentFile` (mode 600, gitignored).
- `Caddyfile` — the site `aerun-world.com`: `/api/*` and `/_/*` are proxied to
  the backend, everything else is served statically from
  `/home/deploy/project/dist` with an SPA fallback (`try_files … /index.html`).

## Caddy management

Caddy is the TLS termination and reverse proxy for `aerun-world.com`. Use the
local `deploy.py` CLI to manage it without SSHing to the VPS manually:

```bash
# Hot-reload Caddyfile (pick up config changes without dropping connections)
python deploy.py caddy reload

# Full restart of Caddy service
python deploy.py caddy restart

# Check Caddy service state
python deploy.py caddy status
```

- `reload` reads the new `backend/deploy/Caddyfile` and applies it gracefully.
- `restart` fully restarts the Caddy systemd unit.
- `status` prints `is-active`, `is-enabled` and the last journal lines.

Remember to `git commit` and `git push` any `Caddyfile` change first, then run
`python deploy.py sync` so the VPS clone has the updated file before reloading.

## Deploy sequence (feature/pocketbase-migration only)

The server clone (`~/project`) stays on the `feature/pocketbase-migration`
branch; `main` is the legacy Firebase-era branch and is never deployed.

```bash
cd ~/project
git fetch origin && git reset --hard origin/feature/pocketbase-migration
# frontend: build locally (the VPS has ~900MB RAM, npm ci gets OOM-killed)
#   npm ci && VITE_POCKETBASE_URL=https://aerun-world.com npm run build
#   tar -czf dist.tgz -C dist . && scp dist.tgz deploy@<vps>:/tmp/
ssh deploy@<vps>
tar -xzf /tmp/dist.tgz -C ~/project/dist
# backend: cross-compile and upload (go binary does NOT survive the scp size
# limit of the tunnel reliably — always send it gzip-compressed and verify
# sha256 on both sides; ~36MB raw gets truncated to ~23MB in flight)
cd backend && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o aerun-linux ./cmd/aerun
tar -czf aerun-linux.tar.gz aerun-linux && scp … ; ssh tar -xzf … && mv aerun-linux aerun
sudo systemctl restart aerun.service
```

Migrations apply automatically on start. The first start on a fresh `pb_data`
prints a superuser installer URL (valid for a limited time) into
`journalctl -u aerun.service`; open it through `https://aerun-world.com/_/…`.

The old stock-PocketBase service (`pocketbase.service`, `/opt/pocketbase`) is
stopped and disabled; its `pb_data` is left untouched as an archive.