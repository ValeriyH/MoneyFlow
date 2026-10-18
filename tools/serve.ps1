<#
.SYNOPSIS
    Локальний статичний сервер для MoneyFlow.

.DESCRIPTION
    ES-модулі не працюють при відкритті файлу через file:// - браузер
    блокує їх з міркування безпеки. Цей скрипт піднімає звичайний
    HTTP-сервер у корені проєкту, після чого сайт відкривається
    за адресою http://localhost:5500.

    УВАГА: файл зберігається з BOM. Windows PowerShell 5.1 інакше
    прочитає кирилицю в OEM-кодуванні й зламає розбір команд.

.PARAMETER Port
    Порт для прослуховування. За замовчуванням 5500.

.PARAMETER NoBrowser
    Не відкривати браузер після запуску.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/serve.ps1
    powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8080
#>

param(
    [int]$Port = 5500,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# ── Файл середовища ─────────────────────────────────────────────────────────
# Адреса бекенда не живе в git. Локально вона береться з
# tools/local-endpoint.txt (теж у .gitignore) і підставляється у
# згенерований assets/js/generated/env.js перед стартом сервера.

$localEndpointFile = Join-Path $PSScriptRoot 'local-endpoint.txt'
$generatedEnvFile  = Join-Path $projectRoot 'assets\js\generated\env.js'

if (Test-Path -LiteralPath $localEndpointFile) {
    $endpoint = (Get-Content -LiteralPath $localEndpointFile -Raw).Trim()

    if ($endpoint -notmatch '^https://') {
        throw "local-endpoint.txt must contain a full https:// URL. Got: '$endpoint'"
    }

    $envFileContent = @"
window.__MONEYFLOW_ENV__ = { APPS_SCRIPT_ENDPOINT: "$endpoint" };
"@
    [System.IO.File]::WriteAllText($generatedEnvFile, $envFileContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  Env: endpoint loaded from tools/local-endpoint.txt" -ForegroundColor DarkGray
}
elseif (Test-Path -LiteralPath $generatedEnvFile) {
    Write-Host '  Env: using existing assets/js/generated/env.js' -ForegroundColor DarkGray
}
else {
    Write-Host ''
    Write-Host '  WARNING: no endpoint configured - the site will show a setup screen.' -ForegroundColor Yellow
    Write-Host '  Create tools/local-endpoint.txt with your Apps Script URL.' -ForegroundColor DarkGray
}

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

# Порт може бути зайнятий не закритим попереднім запуском.
# Кажемо про це людською мовою замість стеку.
try {
    $listener.Start()
}
catch {
    Write-Host ''
    Write-Host "  Port $Port is already in use." -ForegroundColor Red
    Write-Host '  Another MoneyFlow server is probably still running - close its window.' -ForegroundColor DarkGray
    Write-Host '  Or start this one on a different port:' -ForegroundColor DarkGray
    Write-Host "    start.cmd -Port $($Port + 1)" -ForegroundColor Cyan
    Write-Host ''
    exit 1
}

try {
    # Повідомлення лишаються в ASCII: кодова сторінка консолі
    # (cp866, cp1251, cp1252) залежить від системи, і кирилиця
    # перетворилася б на «кракозябри» у когось на комп'ютері.
    Write-Host ''
    Write-Host '  MoneyFlow - local server' -ForegroundColor Cyan
    Write-Host "  Root: $projectRoot" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "  Open: http://localhost:$Port/" -ForegroundColor Green
    Write-Host '  Press Ctrl+C in this window to stop' -ForegroundColor DarkGray
    Write-Host ''

    if (-not $NoBrowser) {
        Start-Process "http://localhost:$Port/"
    }

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $relativePath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))
        if ($relativePath -eq '') { $relativePath = 'index.html' }

        $filePath = Join-Path $projectRoot ($relativePath -replace '/', '\')

        # Не даємо вийти за межі проєкту через ../ у шляху.
        if (-not $filePath.StartsWith($projectRoot) -or -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            $response.StatusCode = 404
            $response.Close()
            continue
        }

        $extension = [System.IO.Path]::GetExtension($filePath).ToLower()
        $contentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }

        $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
        $response.ContentType = $contentType
        $response.ContentLength64 = $fileBytes.Length
        # Під час розробки браузер не має кешувати: інакше правка
        # в CSS або JS не підхопиться до перезавантаження сторінки.
        $response.Headers.Add('Cache-Control', 'no-store, must-revalidate')
        $response.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
        $response.Close()

        Write-Host "200 $relativePath" -ForegroundColor DarkGray
    }
}
finally {
    # Обгортка try/catch: якщо Start() не вдався, об'єкт уже
    # звільнений, і Stop() кинув би ObjectDisposedException,
    # замазавши справжню причину відмови.
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
}