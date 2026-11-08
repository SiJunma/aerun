#!/usr/bin/env python3
"""Aerun VPS deploy CLI (feature/pocketbase-migration). See deploy.py --help."""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

HOST = "202.148.54.64"
DEPLOY_USER = "deploy"
ROOT_USER = "root"
KEY = r"C:\Users\alina\.ssh\aerun_deploy"
BRANCH = "main"
PROD_URL = "https://aerun-world.com"
HEALTH_PATH = "/api/aerun/health"
CHUNK = 256 << 10

ROOT = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(ROOT, ".deploy")
BACKUP_DIR = os.path.join(WORK, "backups")
BACKUP_GLOB = "pb_data-backup-*.tgz"
FRONT_LOCAL = os.path.join(WORK, "dist.tgz")
BACK_LOCAL = os.path.join(WORK, "aerun-linux.tar.gz")
BACK_BIN = os.path.join(WORK, "aerun-linux")
FRONT_REMOTE = "/tmp/aerun-dist.tgz"
BACK_REMOTE = "/tmp/aerun-linux.tar.gz"
REMOTE_DIST = "~/project/dist"
REMOTE_BACKEND = "~/project/backend"
REMOTE_BIN = "~/project/backend/aerun"


class Fail(Exception):
    pass


def log(msg):
    print(msg, flush=True)


def run(cmd, cwd=None, env=None, capture=False):
    display = cmd if isinstance(cmd, str) else " ".join(cmd)
    log("$ " + display)
    proc = subprocess.run(
        cmd, cwd=cwd or ROOT, env=env, shell=isinstance(cmd, str),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    out = proc.stdout or ""
    if proc.returncode != 0:
        tail = "\n".join(out.splitlines()[-25:])
        raise Fail("command failed (%d): %s\n%s" % (proc.returncode, display, tail))
    if capture:
        return out
    for line in out.splitlines()[-5:]:
        if line.strip():
            log("  " + line)
    return out


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _key():
    import paramiko

    return paramiko.Ed25519Key.from_private_key_file(KEY)


def ssh_exec(cmd: str, *, user: str = DEPLOY_USER, timeout: int = 300):
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=22, username=user, pkey=_key(),
                   look_for_keys=False, allow_agent=False, timeout=30)
    try:
        _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err
    finally:
        client.close()


def ssh(cmd: str, *, user: str = DEPLOY_USER, timeout: int = 300) -> str:
    log(f"[{user}@vps]$ {cmd}")
    code, out, err = ssh_exec(cmd, user=user, timeout=timeout)
    if out.strip():
        for line in out.rstrip().splitlines()[-20:]:
            log(f"  | {line}")
    if code != 0:
        raise Fail(f"remote command failed ({code}): {cmd}\n{out}\n{err}")
    if err.strip():
        log(f"  ! stderr: {err.strip()[:500]}")
    return out


def sftp_download(remote: str, local: str) -> None:
    """SFTP download with progress + sha256 verification (mirror of sftp_put)."""
    import paramiko

    os.makedirs(os.path.dirname(local), exist_ok=True)
    transport = paramiko.Transport((HOST, 22))
    transport.set_keepalive(15)
    transport.connect(username=DEPLOY_USER, pkey=_key())
    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        size = sftp.stat(remote).st_size
        log(f"download {remote} -> {local} ({size} bytes)")
        last = [0]

        def _cb(transferred, total):
            if transferred - last[0] >= 8 << 20 or transferred == total:
                last[0] = transferred
                log(f"  ... {transferred}/{total} ({transferred * 100 // total if total else 100}%)")

        sftp.get(remote, local, callback=_cb)
    finally:
        sftp.close()
        transport.close()
    if os.path.getsize(local) != size:
        raise Fail(f"size mismatch for {remote}: expected {size}, got {os.path.getsize(local)}")
    digest = sha256_file(local)
    log(f"  local sha256: {digest}")
    out = ssh(f"sha256sum {remote}")
    if digest not in out:
        raise Fail(f"sha256 mismatch for {remote}:\nlocal  {digest}\nremote {out}")
    log(f"  sha256 OK: {digest[:16]}...")


def latest_backup():
    """Newest pb_data-backup-*.tgz on the VPS (by mtime), or None."""
    out = ssh("ls -1t ~/project/%s 2>/dev/null | head -n 1" % BACKUP_GLOB)
    name = out.strip().splitlines()[0].strip() if out.strip() else ""
    return name or None


def cmd_backup_download(args) -> None:
    name = args.file
    if not name:
        log("== no --file given, picking newest backup on VPS ==")
        name = latest_backup()
        if not name:
            raise Fail("no %s found on VPS - run: python deploy.py db backup" % BACKUP_GLOB)
        log(f"  newest: {name}")
    remote = name if name.startswith(("/","~/")) else "~/project/" + name.lstrip("~/")
    if args.out:
        local = args.out
    else:
        local = os.path.join(BACKUP_DIR, os.path.basename(remote.rstrip("/")))
    if os.path.exists(local) and not args.overwrite:
        raise Fail(f"{local} already exists (use --overwrite or --out <path>)")
    sftp_download(remote, local)
    log(f"DOWNLOAD OK: {local}")
    log("  restore locally: extract over backend/pb_data (stop local backend first)")


def sftp_put(local: str, remote: str) -> None:
    """Chunked SFTP upload with resume + sha256 verification."""
    import paramiko

    size = os.path.getsize(local)
    digest = sha256_file(local)
    total = (size + CHUNK - 1) // CHUNK
    log(f"upload {local} -> {remote} ({size} bytes, {total} chunks)")

    code, out, _ = ssh_exec(f"ls {remote}.q* 2>/dev/null; true")
    have: dict = {}
    for token in out.split():
        token = token.strip()
        if token.startswith(remote + ".q"):
            c2, o2, _ = ssh_exec(f"stat -c %s {token}")
            try:
                if c2 == 0:
                    have[token] = int(o2.strip().split()[0])
            except (ValueError, IndexError):
                pass
    if have:
        log(f"  resume: {len(have)}/{total} chunks already on server")
    else:
        ssh(f"rm -f {remote}.c* {remote}.part; true")

    transport = paramiko.Transport((HOST, 22))
    transport.set_keepalive(15)
    transport.connect(username=DEPLOY_USER, pkey=_key())
    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        with open(local, "rb") as f:
            for i in range(total):
                data = f.read(CHUNK)
                rpart = f"{remote}.q{i:04d}"
                if have.get(rpart) == len(data):
                    continue
                tmp = local + f".r{i:04d}"
                with open(tmp, "wb") as pf:
                    pf.write(data)
                for attempt in range(12):
                    try:
                        sftp.put(tmp, rpart)
                        assert sftp.stat(rpart).st_size == len(data)
                        break
                    except Exception as exc:
                        log(f"  retry chunk {i + 1}/{total} attempt {attempt + 1}: {exc!r}")
                        time.sleep(3)
                else:
                    raise Fail(f"chunk {i + 1}/{total} failed after 12 attempts")
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                if (i + 1) % 20 == 0 or i + 1 == total:
                    log(f"  ... {i + 1}/{total}")
    finally:
        sftp.close()
        transport.close()

    parts = " ".join(f"{remote}.q{i:04d}" for i in range(total))
    out = ssh(f"cat {parts} > {remote} && sha256sum {remote} && rm -f {remote}.q* {remote}.c* {remote}.part")
    if digest not in out:
        raise Fail(f"sha256 mismatch for {remote}:\nlocal  {digest}\nremote {out}")
    log(f"  sha256 OK: {digest[:16]}...")


def wait_for_health(*, tries: int = 12, pause: float = 10.0) -> str:
    last = ""
    for i in range(1, tries + 1):
        code, out, _ = ssh_exec("curl -s -m 10 http://127.0.0.1:8090/api/aerun/health; echo")
        last = out.strip()
        if code == 0 and '"status":"ok"' in out.replace(" ", ""):
            log(f"  backend healthy on try {i}/{tries}")
            return out.strip()
        log(f"  health not ok yet ({i}/{tries}), waiting {pause:.0f}s...")
        time.sleep(pause)
    raise Fail(f"backend did not become healthy:\n{last}")


def public_get(path: str) -> str:
    """GET a public URL. Prefers system curl (fresh CA store) over urllib.

    Python 3.12's bundled CA store predates the 2026 Let's Encrypt root
    rollover (Root YE / ISRG Root X2), so verified urllib fails even though
    the chain is valid. System curl uses the Windows store and verifies fine.
    curl -k is the last resort: the body proves the deploy, not the chain.
    """
    import ssl

    url = PROD_URL + path
    curl = shutil.which("curl")
    if curl:
        proc = subprocess.run(
            [curl, "-s", "-m", "20", "-A", "aerun-deploy/1", url],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout
        log("  ! verified curl failed, retrying urllib...")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "aerun-deploy/1"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        log("  ! verified HTTPS failed (%r), retrying with curl -k..." % (exc,))
    if not curl:
        raise Fail("curl not found and verified HTTPS failed for %s" % url)
    proc = subprocess.run(
        [curl, "-sk", "-m", "20", "-A", "aerun-deploy/1", url],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if proc.returncode != 0:
        raise Fail("public GET failed for %s:\n%s" % (url, proc.stdout))
    return proc.stdout


def public_health() -> str:
    body = public_get(HEALTH_PATH)
    log("  public %s -> %s" % (PROD_URL + HEALTH_PATH, body.strip()[:200]))
    if '"status"' not in body or '"ok"' not in body:
        raise Fail("public health not ok: %s" % body)
    return body


def public_front() -> None:
    body = public_get("/")
    log("  public %s/ -> %d bytes" % (PROD_URL, len(body)))
    if "Aerun" not in body and '<div id="root">' not in body:
        raise Fail("frontend does not look like the Aerun SPA")


def step_pull() -> None:
    log("== 1. git fetch (local, no hard reset) ==")
    run(["git", "fetch", "origin", "--prune"])
    run(["git", "checkout", BRANCH])
    head = run(["git", "rev-parse", "--short", "HEAD"], capture=True).strip()
    log("  local HEAD: " + head)


def step_build_frontend() -> None:
    log("== 2. build frontend ==")
    env = dict(os.environ)
    env["VITE_POCKETBASE_URL"] = PROD_URL
    run("npm run build", env=env)
    index = os.path.join(ROOT, "dist", "index.html")
    if not os.path.isfile(index):
        raise Fail("dist/index.html missing after build")
    os.makedirs(WORK, exist_ok=True)
    if os.path.exists(FRONT_LOCAL):
        os.remove(FRONT_LOCAL)
    with tarfile.open(FRONT_LOCAL, "w:gz") as tar:
        tar.add(os.path.join(ROOT, "dist"), arcname=".")
    log("  packed dist.tgz (%d bytes)" % os.path.getsize(FRONT_LOCAL))


def step_build_backend() -> None:
    log("== 3. cross-compile backend ==")
    env = dict(os.environ)
    env["GOOS"] = "linux"
    env["GOARCH"] = "amd64"
    env["CGO_ENABLED"] = "0"
    os.makedirs(WORK, exist_ok=True)
    if os.path.exists(BACK_BIN):
        os.remove(BACK_BIN)
    run(["go", "build", "-o", BACK_BIN, "./cmd/aerun"],
        cwd=os.path.join(ROOT, "backend"), env=env)
    with open(BACK_BIN, "rb") as f:
        magic = f.read(4)
    if magic != b"\x7fELF":
        raise Fail("built binary is NOT Linux ELF (magic=%r) - refusing to deploy" % (magic,))
    log("  ELF check OK")
    if os.path.exists(BACK_LOCAL):
        os.remove(BACK_LOCAL)
    with tarfile.open(BACK_LOCAL, "w:gz") as tar:
        tar.add(BACK_BIN, arcname="aerun-linux")
    log("  packed aerun-linux.tar.gz (%d bytes)" % os.path.getsize(BACK_LOCAL))


def step_unpack_frontend() -> None:
    log("== 5. unpack frontend on VPS ==")
    ssh("tar -xzf %s -C %s && ls %s/index.html && head -c 200 %s/index.html; echo"
        % (FRONT_REMOTE, REMOTE_DIST, REMOTE_DIST, REMOTE_DIST))


def step_swap_backend() -> None:
    log("== 6. swap backend binary on VPS ==")
    ssh("cd %s && rm -f aerun && tar -xzf %s && mv -f aerun-linux aerun && chmod +x aerun"
        " && head -c 4 aerun | od -A x -t x1z && sha256sum aerun"
        % (REMOTE_BACKEND, BACK_REMOTE))
    code, out, _ = ssh_exec("head -c 4 %s | od -A x -t x1z" % REMOTE_BIN)
    if "7f 45 4c 46" not in out:
        raise Fail("remote binary is NOT ELF after swap:\n" + out)
    log("  remote ELF check OK")


def step_sync_repo() -> None:
    log("== 7. sync VPS clone (fetch only, no hard reset) ==")
    out = ssh(f"cd ~/project && git fetch origin --prune && git rev-parse --short HEAD")
    lines = [l for l in out.strip().splitlines() if l.strip()]
    log("  VPS HEAD: " + (lines[-1] if lines else "?"))
    ssh("rm -f %s.q* %s.q* /tmp/*.part; true" % (FRONT_REMOTE, BACK_REMOTE))


def step_restart() -> None:
    log("== 8. restart aerun.service ==")
    ssh("systemctl restart aerun.service", user=ROOT_USER, timeout=600)
    time.sleep(6)
    out = ssh("systemctl is-active aerun.service", user=ROOT_USER)
    if "active" not in out:
        diag = ssh_exec("journalctl -u aerun.service --no-pager -n 30", user=ROOT_USER)[1]
        raise Fail("service not active after restart:\n" + diag)
    wait_for_health()


def step_verify() -> None:
    log("== 9. verify ==")
    wait_for_health(tries=6, pause=5.0)
    public_health()
    public_front()
    out = ssh("journalctl -u aerun.service --no-pager -n 8", user=ROOT_USER)
    if "backend healthy" not in out:
        log("  ! no 'backend healthy' line in recent journal (non-fatal)")
    log("DEPLOY OK")


def cmd_caddy(args) -> None:
    action = args.caddy_action
    # IaC drift that caused the QUIC/SSE reconnect storm: the repo Caddyfile
    # had been edited after the live /etc/caddy/Caddyfile was installed,
    # so the fix never reached the VPS. This pulls the repo file from
    # origin/main, validates it, and reloads — never a bare reload of a
    # stale file.
    def install_and_reload(extra_verify=False):
        # NOTE: root's HOME is /root, deploy's is /home/deploy. Using
        # ~/project under ROOT_USER fails; use the absolute path.
        cmd = (
            "cd /home/deploy/project && git fetch origin --prune && "
            "git show origin/main:backend/deploy/Caddyfile > backend/deploy/Caddyfile && "
            "cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d) && "
            "cp backend/deploy/Caddyfile /etc/caddy/Caddyfile && "
            "caddy validate --config /etc/caddy/Caddyfile && "
            "systemctl reload caddy"
        )
        if extra_verify:
            cmd += " && sleep 1 && curl -sI http://127.0.0.1/api/realtime | head -20 || true"
        ssh(cmd, user=ROOT_USER, timeout=60)

    if action == "install":
        log("== install Caddyfile (origin/main) + validate + reload ==")
        install_and_reload(extra_verify=True)
    elif action == "reload":
        log("== install Caddyfile (origin/main) + validate + reload ==")
        install_and_reload()
    elif action == "restart":
        log("== restart caddy ==")
        ssh("systemctl restart caddy", user=ROOT_USER, timeout=60)
        time.sleep(2)
    elif action == "status":
        log("== caddy status ==")
        ssh("systemctl is-active caddy && systemctl is-enabled caddy", user=ROOT_USER)
        ssh("systemctl status caddy --no-pager -n 8", user=ROOT_USER)
    log("CADDY %s OK" % action.upper())


def cmd_db(args) -> None:
    if args.db_action == "backup":
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = "~/project/pb_data-backup-%s.tgz" % stamp
        log("== db backup -> %s ==" % dest)
        ssh("cd ~/project && tar -czf %s backend/pb_data && ls -la %s" % (dest, dest))
        log("BACKUP OK")
    elif args.db_action == "migrate":
        log("== db migrate (restart; Go migrations auto-apply on start) ==")
        step_restart()
        out = ssh("journalctl -u aerun.service --no-pager -n 40"
                  " | grep -i -E 'migrat|healthy|error' || true", user=ROOT_USER)
        log(out if out.strip() else "  (no migration lines in journal)")
        log("MIGRATE OK - verify data in the PocketBase admin UI")
    elif args.db_action == "restore":
        if not args.file:
            raise Fail("db restore needs --file <name.tgz>")
        if not args.yes and input(
                "Restore %s over live pb_data? Service will stop. [y/N] " % args.file
        ).lower() != "y":
            raise Fail("aborted")
        log("== db restore %s ==" % args.file)
        ssh("systemctl stop aerun.service", user=ROOT_USER, timeout=300)
        ssh("cd ~/project && test -f %s && rm -rf backend/pb_data"
            " && tar -xzf %s && ls backend/pb_data | head" % (args.file, args.file))
        ssh("systemctl start aerun.service", user=ROOT_USER, timeout=300)
        time.sleep(6)
        wait_for_health()
        log("RESTORE OK")
    else:
        raise Fail("unknown db action: %s" % (args.db_action,))


def build_parser():
    p = argparse.ArgumentParser(prog="deploy.py",
                                description="Aerun VPS deploy CLI (PocketBase branch)")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("deploy", help="full deploy: pull + build + upload + restart + verify")
    d.add_argument("--only", choices=["frontend", "backend"], default=None,
                   help="deploy only one side (frontend = no restart)")
    d.add_argument("--skip-build", action="store_true",
                   help="reuse artifacts already in .deploy/")
    d.add_argument("--skip-restart", action="store_true",
                   help="upload/unpack only, do not restart")
    d.add_argument("--yes", action="store_true", help="skip confirmation prompt")
    sub.add_parser("frontend", help="build + upload + unpack frontend only (no restart)")
    sub.add_parser("backend", help="cross-compile + upload + swap + restart backend only")
    sub.add_parser("restart", help="restart aerun.service + health check")
    sub.add_parser("sync", help="git fetch/reset on VPS only (no artifacts)")
    sub.add_parser("status", help="service state + deployed commit + disk use")
    sub.add_parser("health", help="VPS loopback + public API + frontend checks")
    caddy = sub.add_parser("caddy", help="manage Caddy reverse proxy (install/reload/restart/status)")
    caddy.add_argument("caddy_action", choices=["install", "reload", "restart", "status"])
    db = sub.add_parser("db", help="pre-release database helpers")
    db.add_argument("db_action", choices=["backup", "migrate", "restore"])
    db.add_argument("--file", default=None, help="backup file for db restore")
    db.add_argument("--yes", action="store_true", help="skip confirmation for restore")
    backup = sub.add_parser("backup", help="download a DB backup from VPS to this PC")
    backup.add_argument("--file", default=None,
                          help="backup on VPS (default: newest pb_data-backup-*.tgz)")
    backup.add_argument("--out", default=None,
                        help="local path (default: .deploy/backups/<name>)")
    backup.add_argument("--overwrite", action="store_true",
                        help="overwrite existing local file")
    return p


def cmd_deploy(args) -> None:
    if not args.yes:
        scope = args.only or "frontend+backend"
        ans = input("Deploy %s from %s to %s? [y/N] " % (scope, BRANCH, PROD_URL)).strip().lower()
        if ans != "y":
            raise Fail("aborted")
    only = args.only
    do_front = only in (None, "frontend")
    do_back = only in (None, "backend")
    step_pull()
    if not args.skip_build:
        if do_front:
            step_build_frontend()
        if do_back:
            step_build_backend()
    else:
        log("== build skipped, reusing .deploy/ ==")
        if do_front and not os.path.isfile(FRONT_LOCAL):
            raise Fail(FRONT_LOCAL + " missing - run without --skip-build first")
        if do_back and not os.path.isfile(BACK_LOCAL):
            raise Fail(BACK_LOCAL + " missing - run without --skip-build first")
    if do_front:
        sftp_put(FRONT_LOCAL, FRONT_REMOTE)
        step_unpack_frontend()
    if do_back:
        sftp_put(BACK_LOCAL, BACK_REMOTE)
        step_swap_backend()
    step_sync_repo()
    if args.skip_restart or only == "frontend":
        log("restart skipped (frontend-only)")
    else:
        step_restart()
    step_verify()


def cmd_status() -> None:
    log("== status ==")
    ssh("systemctl status aerun.service --no-pager -n 5", user=ROOT_USER)
    ssh("cd ~/project && git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD"
        " && du -sh backend/pb_data dist 2>/dev/null; ss -ltnp | grep 8090 || true")
    public_health()


def cmd_health() -> None:
    log("== health ==")
    wait_for_health(tries=3, pause=3.0)
    public_health()
    public_front()
    log("HEALTH OK")


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.cmd == "deploy":
            cmd_deploy(args)
        elif args.cmd == "frontend":
            step_pull()
            step_build_frontend()
            sftp_put(FRONT_LOCAL, FRONT_REMOTE)
            step_unpack_frontend()
            public_front()
            log("FRONTEND OK")
        elif args.cmd == "backend":
            step_pull()
            step_build_backend()
            sftp_put(BACK_LOCAL, BACK_REMOTE)
            step_swap_backend()
            step_sync_repo()
            step_restart()
            step_verify()
        elif args.cmd == "restart":
            step_restart()
            step_verify()
        elif args.cmd == "sync":
            step_sync_repo()
            log("SYNC OK")
        elif args.cmd == "status":
            cmd_status()
        elif args.cmd == "health":
            cmd_health()
        elif args.cmd == "caddy":
            cmd_caddy(args)
        elif args.cmd == "db":
            cmd_db(args)
        elif args.cmd == "backup":
            cmd_backup_download(args)
        return 0
    except Fail as exc:
        log("FATAL: %s" % exc)
        return 1
    except KeyboardInterrupt:
        log("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
