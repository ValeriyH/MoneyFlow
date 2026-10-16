$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ASCII-only ON PURPOSE: Windows PowerShell 5.1 reads .ps1 without BOM in the
# OEM codepage, which mangles non-ASCII literals and breaks the parser.

function Get-Anchors([string]$path) {
  $set = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)) {
    if ($line -match '^#{1,6}\s+(.*?)\s*$') {
      $text = $Matches[1] -replace '`', ''
      $slug = $text.ToLowerInvariant()
      $slug = [regex]::Replace($slug, '[^\p{L}\p{Nd}\s-]', '')
      $slug = [regex]::Replace($slug, '\s+', '-')
      if (-not $set.ContainsKey($slug)) { $set[$slug] = $text }
    }
  }
  return $set
}

$root = "$PSScriptRoot\.."
$readmeAnchors = Get-Anchors "$root\README.md"
$agentAnchors  = Get-Anchors "$root\AGENTS.md"

$files = @{
  'README.md' = $readmeAnchors
  'AGENTS.md' = $agentAnchors
}

$problems = 0

foreach ($file in @('README.md', 'AGENTS.md')) {
  Write-Output ("=== " + $file + " ===")

  $full = Join-Path $root $file
  $text = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
  $linkRegex = [regex]'\]\((?<target>[^)\s]+)\)'

  foreach ($m in $linkRegex.Matches($text)) {
    $target = $m.Groups['target'].Value
    $hash = $target.IndexOf('#')
    if ($hash -lt 0) { continue }

    $path = $target.Substring(0, $hash)
    $anchor = $target.Substring($hash + 1)

    if ([string]::IsNullOrEmpty($path)) {
      $ok = $files[$file].ContainsKey($anchor)
    } else {
      $other = Join-Path $root $path
      if (-not (Test-Path $other)) {
        Write-Output ("  FILE MISSING : " + $target)
        $problems++
        continue
      }
      $ok = $files[[System.IO.Path]::GetFileName($path)].ContainsKey($anchor)
    }

    if ($ok) {
      Write-Output ("  ok            " + $target)
    } else {
      Write-Output ("  BROKEN        " + $target)
      $problems++
    }
  }

  Write-Output ("  headings: " + $files[$file].Count)
}

Write-Output ""
if ($problems -eq 0) {
  Write-Output "All anchors resolve."
} else {
  Write-Output ("Broken: " + $problems)
}