# Deploy (VPS, PocketBase branch)

One script, no agents: `python deploy.py <command>` from the repo root.
Full help: `python deploy.py --help`, `python deploy.py db --help`.

| Command | What it does |
|---|---|
| `deploy [--yes]` | Everything: git pull → build front+back → upload → unpack → restart → verify |
| `deploy --only frontend [--yes]` | Only the SPA (no service restart) |
| `deploy --only backend [--yes]` | Only the Go binary (with restart) |
| `deploy --skip-build` | Reuse `.deploy/` artifacts, skip npm/go builds |
| `deploy --skip-restart` | Upload + unpack only, leave the running service alone |
| `frontend` | Build + upload + unpack the SPA, then check `https://aerun-world.com/` |
| `backend` | Cross-compile + upload + swap binary + restart + full verify |
| `restart` | `systemctl restart aerun.service` + wait for healthy + verify |
| `sync` | `git fetch/reset` on the VPS clone only, no artifacts |
| `status` | systemd state + VPS commit + disk use + public health |
| `health` | VPS loopback + public API + frontend (read-only, safe anytime) |
| `db backup` | `tar -czf ~/project/pb_data-backup-<stamp>.tgz backend/pb_data` on VPS |
| `db migrate` | Restart (Go migrations auto-apply on start) + show migration lines |
| `db restore --file <name.tgz> [--yes]` | Stop service → replace `pb_data` → start → health |

Notes:

- Branch is pinned to `feature/pocketbase-migration` on both sides; `main`
  (legacy Firebase) is never touched.
- Requirements: `python + paramiko`, `node/npm`, `go`, SSH key
  `C:\Users\alina\.ssh\aerun_deploy`.
- Local build artifacts live in `.deploy/` (gitignored); uploads go to `/tmp`
  in 256 KiB chunks with resume and sha256 verification (the tunnel truncates
  big raw files, hence gzip + hash check).
- Two ELF guards (local + remote) refuse to ship a Windows binary — that was
  the `203/EXEC` outage.
- Public HTTPS checks tolerate an expired certificate (verified try first,
  then `curl -k`): the body proves the deploy, not the cert chain. If you see
  the `! verified HTTPS failed` line, renew the Caddy cert when convenient.
