@echo off
REM Local backend launcher.
REM
REM Kept as a file so the server can be started WITHOUT a controlling console:
REM starting it inline (Start-Process, or cmd /c ... from an interactive shell)
REM leaves it in the caller's process group, so a Ctrl+C in that shell — including
REM the one an agent or a terminal sends when a command times out — reaches the
REM server and kills it. It must be launched through a detached mechanism.
REM
REM The working directory is pinned because AERUN_DATA_DIR defaults to ./pb_data
REM and config.SeedDotEnv() looks for .env.local in the cwd and its parent. Started
REM from anywhere else, the server silently builds an EMPTY database beside the
REM caller instead of using the real one.
cd /d "%~dp0backend"
"%~dp0.local-run\aerun.exe"