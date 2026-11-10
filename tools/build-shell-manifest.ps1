<#
.SYNOPSIS
    Writes the offline shell version and file list into a built site's sw.js.

.DESCRIPTION
    Runs on an already assembled site folder (deploy/ locally, _site/ on GitHub
    Actions), never on the repository itself: the source sw.js stays a "dev"
    template, so git shows no change after a build.

    The file list is read from the site folder. That is safe because the folder
    is assembled from an explicit list by tools/deploy.ps1 and
    .github/workflows/pages.yml - nothing private gets there.

    The version is a SHA-256 over the sw.js template and every shell file
    (path + bytes). Any change of a shell file or of the worker logic gives a
    new sw.js, and only a changed sw.js makes the browser install an update.

    Works on Windows PowerShell 5.1 and PowerShell 7 (GitHub runner). ASCII
    only on purpose, so no BOM is required.

.PARAMETER SiteDir
    The assembled site folder that contains index.html and sw.js.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/build-shell-manifest.ps1 -SiteDir deploy
    pwsh ./tools/build-shell-manifest.ps1 -SiteDir _site
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$SiteDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SiteDir -PathType Container)) {
    throw "Site folder not found: $SiteDir"
}

$siteRoot = (Resolve-Path -LiteralPath $SiteDir).Path.TrimEnd('\', '/')
$workerPath = Join-Path $siteRoot 'sw.js'

if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw "sw.js not found in $siteRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $siteRoot 'index.html') -PathType Leaf)) {
    throw "index.html not found in $siteRoot"
}

# Not part of the shell: the worker itself (the browser fetches it separately),
# robots.txt (crawlers only) and the env template (never loaded by the page).
$excludedPaths = @(
    'sw.js'
    'robots.txt'
    'assets/js/generated/env.example.js'
)

$shellFiles = @()
foreach ($file in Get-ChildItem -LiteralPath $siteRoot -Recurse -File) {
    $relativePath = $file.FullName.Substring($siteRoot.Length + 1).Replace('\', '/')
    if ($excludedPaths -contains $relativePath) { continue }

    # The path is written into JavaScript as a string literal: anything outside
    # this set could break the worker or need escaping.
    if ($relativePath -notmatch '^[A-Za-z0-9._/-]+$') {
        throw "Unsupported characters in shell file name: $relativePath"
    }
    $shellFiles += $relativePath
}

# Ordinal sort: the same set must give the same version on Windows and Linux.
[string[]]$sortedFiles = $shellFiles
[Array]::Sort($sortedFiles, [StringComparer]::Ordinal)

if ($sortedFiles.Count -eq 0) {
    throw "No shell files found in $siteRoot"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$workerSource = [System.IO.File]::ReadAllText($workerPath, $utf8NoBom)

$versionLine = 'const SHELL_VERSION = "dev";'
$filesLine = 'const SHELL_FILES = [];'

foreach ($line in @($versionLine, $filesLine)) {
    $occurrences = ([regex]::Matches($workerSource, [regex]::Escape($line))).Count
    if ($occurrences -ne 1) {
        throw "sw.js must contain the line '$line' exactly once (found $occurrences). Was it already built?"
    }
}

# ── Version hash ─────────────────────────────────────────────────────────────

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hashStream = New-Object System.IO.MemoryStream
try {
    $templateBytes = $utf8NoBom.GetBytes($workerSource)
    $hashStream.Write($templateBytes, 0, $templateBytes.Length)

    foreach ($relativePath in $sortedFiles) {
        # A zero byte separates path and content, so "a" + "bc" never equals "ab" + "c".
        $pathBytes = $utf8NoBom.GetBytes("`0$relativePath`0")
        $hashStream.Write($pathBytes, 0, $pathBytes.Length)

        $contentBytes = [System.IO.File]::ReadAllBytes((Join-Path $siteRoot $relativePath))
        $hashStream.Write($contentBytes, 0, $contentBytes.Length)
    }

    $hashBytes = $sha256.ComputeHash($hashStream.ToArray())
}
finally {
    $hashStream.Dispose()
    $sha256.Dispose()
}

$version = (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)

# ── Write the built worker ───────────────────────────────────────────────────

$fileListLiteral = ($sortedFiles | ForEach-Object { "  `"$_`"," }) -join "`n"
$builtSource = $workerSource.Replace($versionLine, "const SHELL_VERSION = `"$version`";")
$builtSource = $builtSource.Replace($filesLine, "const SHELL_FILES = [`n$fileListLiteral`n];")

[System.IO.File]::WriteAllText($workerPath, $builtSource, $utf8NoBom)

Write-Host "  Shell: version $version, $($sortedFiles.Count) files precached" -ForegroundColor DarkGray
