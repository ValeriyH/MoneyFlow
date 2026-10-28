<#
.SYNOPSIS
    Builds MoneyFlow into the deploy folder for any static hosting.

.DESCRIPTION
    GitHub Pages is not the only platform for a static site. This script
    prepares a standard folder with files that can be sent anywhere:
    Netlify, Cloudflare Pages, Vercel, Firebase Hosting, your own nginx,
    or simply a folder uploaded manually.

    The deploy/ folder is overwritten every time: old content must not
    remain because a forgotten module in the browser acts like stale
    code, and errors due to this are not visible.

    The backend address is not in git, but is generated from
    tools/local-endpoint.txt - exactly what serve.ps1 does.

    CAUTION: This file is saved with BOM. Windows PowerShell 5.1 otherwise
    reads Cyrillic in OEM encoding and breaks command parsing.

.PARAMETER OutputDir
    Target folder relative to the project root. Default is deploy.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/deploy.ps1
    powershell -ExecutionPolicy Bypass -File tools/deploy.ps1 -OutputDir dist
#>

param(
    [string]$OutputDir = 'deploy'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# ── What is needed on the server ──────────────────────────────────────────
#
# The list is intentionally complete and not read from a directory:
# apps-script (Google's source code), tools, documentation, and
# local passwords must NOT end up in deploy. A script that expands
# itself ("copy all except .git") would copy local-pass.txt just
# once - and then it's gone.

$rootFiles = @(
    'index.html'
    'app.webmanifest'
    'sw.js'
    'robots.txt'
)

$directories = @(
    'assets'
)

# ── Backend address ─────────────────────────────────────────────────────────

$localEndpointFile = Join-Path $PSScriptRoot 'local-endpoint.txt'
$generatedEnvFile  = Join-Path $projectRoot 'assets\js\generated\env.js'

Write-Host ''
Write-Host 'MoneyFlow - deploy' -ForegroundColor Cyan

if (Test-Path -LiteralPath $localEndpointFile) {
    $endpoint = (Get-Content -LiteralPath $localEndpointFile -Raw).Trim()

    if ($endpoint -notmatch '^https://') {
        throw "local-endpoint.txt must contain a full https:// URL. Got: '$endpoint'"
    }

    $envFileContent = @"
window.__MONEYFLOW_ENV__ = { APPS_SCRIPT_ENDPOINT: "$endpoint" };
"@
    [System.IO.File]::WriteAllText($generatedEnvFile, $envFileContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host '  Env: endpoint loaded from tools/local-endpoint.txt' -ForegroundColor DarkGray
}
elseif (Test-Path -LiteralPath $generatedEnvFile) {
    Write-Host '  Env: using existing assets/js/generated/env.js' -ForegroundColor DarkGray
}
else {
    Write-Host ''
    Write-Host '  ERROR: no Apps Script endpoint configured.' -ForegroundColor Red
    Write-Host '  Create tools/local-endpoint.txt with the deployed Web App URL,' -ForegroundColor DarkGray
    Write-Host '  or run start.cmd once so it is generated.' -ForegroundColor DarkGray
    exit 1
}

# ── Clean target folder ─────────────────────────────────────────────────────
#

$targetDir = Join-Path $projectRoot $OutputDir

if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
    Write-Host "  Clean: $OutputDir/" -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Path $targetDir | Out-Null

# ── Copy files ───────────────────────────────────────────────────────────────

foreach ($fileName in $rootFiles) {
    $source = Join-Path $projectRoot $fileName

    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required file missing: $fileName"
    }

    Copy-Item -LiteralPath $source -Destination $targetDir
}

foreach ($directoryName in $directories) {
    $source = Join-Path $projectRoot $directoryName

    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required folder missing: $directoryName"
    }

    Copy-Item -LiteralPath $source -Destination $targetDir -Recurse
}

# ── Verify results ──────────────────────────────────────────────────────────
#

$copiedFiles = Get-ChildItem -LiteralPath $targetDir -Recurse -File
$copiedBytes = ($copiedFiles | Measure-Object -Property Length -Sum).Sum

$mustBeThere = @(
    'index.html'
    'app.webmanifest'
    'sw.js'
    'robots.txt'
    'assets\js\generated\env.js'
)

$missing = @()
foreach ($requiredPath in $mustBeThere) {
    if (-not (Test-Path -LiteralPath (Join-Path $targetDir $requiredPath))) {
        $missing += $requiredPath
    }
}

Write-Host ''
Write-Host "  Files:  $($copiedFiles.Count)" -ForegroundColor Green
Write-Host "  Size:   $([Math]::Round($copiedBytes / 1KB, 1)) KB" -ForegroundColor Green
Write-Host "  Folder: $targetDir" -ForegroundColor Green

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '  ERROR: the deploy folder is incomplete:' -ForegroundColor Red
    foreach ($path in $missing) {
        Write-Host "    - $path" -ForegroundColor Red
    }
    exit 1
}

Write-Host ''
Write-Host '  Ready. Upload the contents of this folder to your static host.' -ForegroundColor Cyan
Write-Host '  sw.js must stay next to index.html - otherwise the offline shell' -ForegroundColor DarkGray
Write-Host '  loses its scope and the app will not open without network.' -ForegroundColor DarkGray
Write-Host ''

exit 0
