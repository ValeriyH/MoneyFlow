<#
.SYNOPSIS
    Local static server for MoneyFlow.

.DESCRIPTION
    ES modules don't work when opening a file via file:// - browsers block them for security reasons. This script starts a standard HTTP server at the project root, after which the site can be opened at http://localhost:5500.

    CAUTION: This file is saved with BOM. Windows PowerShell 5.1 otherwise reads Cyrillic in OEM encoding and breaks command parsing.

.PARAMETER Port
    Port to listen on. Default is 5500.

.PARAMETER NoBrowser
    Do not open the browser after starting.

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

# ── Env file ─────────────────────────────────────────────────────────
# Backend address is not in git. Locally, it's taken from
# tools/local-endpoint.txt (also in .gitignore) and is injected into
# the generated assets/js/generated/env.js before the server starts.

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

# The port might be occupied by a previous run that wasn't closed properly.
# We're reporting this in plain language instead of a stack trace.
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
    # Messages remain in ASCII: the console's code page
    # (cp866, cp1251, cp1252) depends on the system, and Cyrillic
    # would turn into "krakozyabry" (garbage characters) on some computers.
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

        # Prevent path traversal via ../ in the URL.
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
        # During development, prevent the browser from caching: otherwise changes
        # in CSS or JS won't be picked up on page reload.
        $response.Headers.Add('Cache-Control', 'no-store, must-revalidate')
        $response.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
        $response.Close()

        Write-Host "200 $relativePath" -ForegroundColor DarkGray
    }
}
finally {
    # Try/catch wrapper: if Start() failed, the object is already
    # disposed, and Stop() would throw an ObjectDisposedException,
    # hiding the actual reason for failure.
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
}
