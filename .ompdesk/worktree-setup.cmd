@echo off
cd /d "%~dp0.."
bun install --frozen-lockfile || exit /b 1
bun scripts/ensure-electron.ts
