# backfill.ps1 - embeds, chunks and links every thought that has no embedded_at yet.
#
# Costs nothing: it uses Supabase's free built-in gte-small model and never
# calls Anthropic, so existing tags are left exactly as they are.
#
# Run from the project folder:   powershell -File scripts\backfill.ps1
# Safe to run again at any time - it only picks up unfinished thoughts.
# To rebuild links after changing LINK_THRESHOLD:   powershell -File scripts\backfill.ps1 -Relink

param([switch]$Relink, [int]$Batch = 5)

$url = "https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought"

if ($Relink) {
  $page = 0
  do {
    $body = @{ type = "RELINK"; page = $page } | ConvertTo-Json
    $r = Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -TimeoutSec 150
    Write-Host "Page $page : $($r.thoughts) thoughts, $($r.links) links"
    $page++
    Start-Sleep -Seconds 1
  } while ($r.more)
  Write-Host "Relink done."
  exit
}

$stuck = 0
$last = -1
do {
  $body = @{ type = "BACKFILL"; batch = $Batch } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -TimeoutSec 150
  } catch {
    Write-Host "  Call failed ($($_.Exception.Message)) - waiting and trying again"
    $stuck++
    if ($stuck -ge 10) { Write-Host "Too many failures - stopping."; break }
    Start-Sleep -Seconds 5
    $r = @{ remaining = 1 }
    continue
  }
  $r.processed | ForEach-Object { Write-Host "  $_" }
  Write-Host "Remaining: $($r.remaining)"

  # A huge transcript can take many rounds of chunks - that's fine. Only give
  # up after ten failures in a row.
  if (($r.processed | Where-Object { $_ -like "failed*" }).Count -gt 0) { $stuck++ } else { $stuck = 0 }
  if ($stuck -ge 10) { Write-Host "Ten failures in a row - stopping. See the 'failed' lines above."; break }

  Start-Sleep -Seconds 2
} while ($r.remaining -gt 0)

Write-Host "Backfill finished."
