# backfill-tags.ps1 - tags, category and summary for older thoughts that were
# saved before auto-tagging existed (enriched_at is empty). Skips course_setup.
#
# Each thought: one Haiku call through call-llm (logged as "enrich-thought"),
# then its main embedding is rebuilt from the new summary + tags and its
# links are refreshed (free). About $0.0002 per thought.
#
# Run from the project folder:
#   Preview 5, save nothing:  powershell -ExecutionPolicy Bypass -File scripts\backfill-tags.ps1 -Preview 5
#   Run all:                  powershell -ExecutionPolicy Bypass -File scripts\backfill-tags.ps1
# Safe to run again: it only picks up thoughts that still have no enriched_at.

param([int]$Preview = 0, [int]$Batch = 3)

$url = "https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought"

# The internal secret, from .env (git-ignored) - every call needs it.
function Get-InternalSecret {
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
  if ($env:INTERNAL_SECRET) { return $env:INTERNAL_SECRET.Trim() }
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^INTERNAL_SECRET=' } | Select-Object -First 1
    if ($line) { return $line.Substring(16).Trim().Trim('"') }
  }
  Write-Host "INTERNAL_SECRET not found. Add a line INTERNAL_SECRET=... to the .env file in the project folder."
  exit 1
}
$headers = @{ "x-internal-secret" = (Get-InternalSecret) }

function Show($r) {
  foreach ($x in $r.results) {
    if ($x.skipped) { Write-Host "  SKIP  $($x.preview)  ($($x.skipped))"; continue }
    Write-Host "  $($x.preview)"
    Write-Host "      [$($x.category)] $($x.tags -join ', ')"
    Write-Host "      $($x.summary)"
  }
}

if ($Preview -gt 0) {
  $body = @{ type = "RETAG"; batch = $Preview; dryRun = $true } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 150
  Write-Host "PREVIEW - nothing saved:"
  Show $r
  exit
}

$after = $null
$fails = 0
do {
  $req = @{ type = "RETAG"; batch = $Batch }
  if ($after) { $req.after = $after }
  try {
    $r = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType "application/json; charset=utf-8" -Body ($req | ConvertTo-Json) -TimeoutSec 150
  } catch {
    $fails++
    Write-Host "  Call failed ($($_.Exception.Message)) - retrying"
    if ($fails -ge 5) { Write-Host "Too many failures - stopping."; break }
    Start-Sleep -Seconds 5
    continue
  }
  $fails = 0
  Show $r
  $after = $r.after
  Write-Host "Remaining: $($r.remaining)"
  Start-Sleep -Seconds 1
} while ($r.remaining -gt 0 -and $r.results.Count -gt 0)

Write-Host "Tag backfill finished."
