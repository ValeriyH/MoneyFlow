@echo off
REM ===========================================================================
REM  MoneyFlow - local run.
REM
REM  Double-click this file: it starts a local HTTP server and opens
REM  the browser. To stop - close this window or press Ctrl+C.
REM
REM  This file is ASCII-only ON PURPOSE. cmd.exe reads a batch file in
REM  the OEM codepage regardless of chcp, so any non-ASCII character in
REM  it makes the parser fail. All human-readable text is printed by
REM  tools/serve.ps1, which reads UTF-8 correctly.
REM
REM  Extra arguments are passed through, e.g.  start.cmd -Port 8080
REM ===========================================================================

setlocal

set "SCRIPT_PATH=%~dp0tools\serve.ps1"

if not exist "%SCRIPT_PATH%" (
  echo serve.ps1 not found next to this file.
  echo Keep start.cmd in the repository root.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_PATH%" %*

if errorlevel 1 pause

endlocal