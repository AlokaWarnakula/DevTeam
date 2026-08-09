@echo off
cd /d "%~dp0"
node bin\devteam.mjs start --open
if errorlevel 1 pause
