<#
.SYNOPSIS
    Збирає MoneyFlow у папку deploy для будь-якого статичного хостингу.

.DESCRIPTION
    GitHub Pages — не єдина платформа для статичного сайту. Скрипт
    готує звичайну теку з файлами, яку можна віддати будь-куди:
    Netlify, Cloudflare Pages, Vercel, Firebase Hosting, власний nginx
    або просто тека, яку вивантажують вручну.

    Папка deploy/ перезаписується щоразу: старий вміст не має
    залишатися, бо забутий модуль у браузері працює як застарілий
    код, а помилки через це не видно.

    Адреса бекенда не живе в git, а генерується з
    tools/local-endpoint.txt - те саме, що робить serve.ps1.

    УВАГА: файл зберігається з BOM. Windows PowerShell 5.1 інакше
    прочитає кирилицю в OEM-кодуванні й зламає розбір команд.

.PARAMETER OutputDir
    Папка призначення відносно кореня проєкту. За замовчуванням deploy.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/deploy.ps1
    powershell -ExecutionPolicy Bypass -File tools/deploy.ps1 -OutputDir dist
#>

param(
    [string]$OutputDir = 'deploy'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# ── Що потрібно на сервері ─────────────────────────────────────────────────
#
# Перелік навмисно повний і не читається з каталогу: у deploy не
# мають потрапити ні apps-script (вихідні коди Google), ні tools,
# ні докуме��тація, ні локальні паролі. Скрипт, що сам себе
# розширює («скопіюй усе, крім .git»), одного разу скопіює
# local-pass.txt - і тоді його нема.

$rootFiles = @(
    'index.html'
    'app.webmanifest'
    'sw.js'
)

$directories = @(
    'assets'
)

# ── Адреса бекенда ─────────────────────────────────────────────────────────

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

# ── Чистимо теку призначення ───────────────────────────────────────────────

$targetDir = Join-Path $projectRoot $OutputDir

if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
    Write-Host "  Clean: $OutputDir/" -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Path $targetDir | Out-Null

# ── Копіюємо ───────────────────────────────────────────────────────────────

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

# ── Перевірка результату ───────────────────────────────────────────────────

$copiedFiles = Get-ChildItem -LiteralPath $targetDir -Recurse -File
$copiedBytes = ($copiedFiles | Measure-Object -Property Length -Sum).Sum

$mustBeThere = @(
    'index.html'
    'app.webmanifest'
    'sw.js'
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