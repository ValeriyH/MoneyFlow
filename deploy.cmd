@echo off
REM ===========================================================================
REM  MoneyFlow - build the deploy folder.
REM
REM  Double-click this file: it collects everything a static host needs
REM  into the "deploy" folder next to it. Upload that folder's contents
REM  to Netlify, Cloudflare Pages, Vercel, nginx, or wherever you like.
REM
REM  This file is ASCII-only ON PURPOSE. cmd.exe reads a batch file in
REM  the OEM codepage regardless of chcp, so any non-ASCII character in
REM  it makes the parser fail. All human-readable text is printed by
REM  tools/deploy.ps1, which reads UTF-8 correctly.
REM
REM  Extra arguments are passed through, e.g.  deploy.cmd -OutputDir dist
REM ===========================================================================

setlocal

set "SCRIPT_PATH=%~dp0tools\deploy.ps1"

if not exist "%SCRIPT_PATH%" (
  echo deploy.ps1 not found next to this file.
  echo Keep deploy.cmd in the repository root.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_PATH%" %*

if errorlevel 1 pause

endlocal