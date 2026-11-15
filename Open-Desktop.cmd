@echo off
cd /d "%~dp0"
node desktop.mjs
if errorlevel 1 pause
