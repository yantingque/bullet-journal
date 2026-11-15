@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or later is required.
  pause
  exit /b 1
)
set "JOURNAL_SHOW_KEY=1"
echo Open http://localhost:8776 in Edge or Chrome.
echo Keep this window open while using the journal.
node server.mjs
pause
