# backfill-kind.ps1 - gives every thought with no `kind` yet a kind.
#
# How it decides (inside enrich-thought, mode CLASSIFY):
#   1. Simple free rules: "Level N on how I made this brain" -> course_setup,
#      weekly digests -> report, YouTube/URL captures and bare links -> source,
#      voice notes, Telegram messages and short notes -> my_thought.
#   2. Only when the rules can't tell (PDFs, long write-ups): one short Haiku
#      call through call-llm, logged in llm_usage as "classify-kind".
#      On the current brain that is 8 calls, about $0.001 in total.
#
# Never touches tags, summaries or embeddings. Safe to run again any time -
# it only picks up thoughts whose kind is still empty.
#
# Run from the project folder:   powershell -ExecutionPolicy Bypass -File scripts\backfill-kind.ps1
# Check the result in the SQL Editor:
#   select kind, kind_set_by, count(*) from thoughts group by 1, 2 order by 1;
# Fix a wrong guess by hand:
#   update thoughts set kind = 'class_note', kind_set_by = 'manual' where id = '...';

param([int]$Batch = 5)

$url = "https://ypcluqihozisgtkloqtn.supabase.co/functions/v1/enrich-thought"

$failRounds = 0
do {
  $body = @{ type = "CLASSIFY"; batch = $Batch } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -TimeoutSec 150
  } catch {
    Write-Host "  Call failed ($($_.Exception.Message)) - waiting and trying again"
    $failRounds++
    if ($failRounds -ge 5) { Write-Host "Too many failures - stopping."; break }
    Start-Sleep -Seconds 5
    $r = @{ remaining = 1 }
    continue
  }
  $r.processed | ForEach-Object { Write-Host "  $_" }
  Write-Host "Remaining: $($r.remaining)"

  # A batch where everything failed means the same thoughts would be retried
  # forever - stop and show the error instead.
  if ($r.failed -gt 0 -and $r.failed -eq @($r.processed).Count) { $failRounds++ } else { $failRounds = 0 }
  if ($failRounds -ge 3) { Write-Host "Three rounds with nothing classified - stopping. See the 'failed' lines above."; break }

  Start-Sleep -Seconds 1
} while ($r.remaining -gt 0)

Write-Host "Kind backfill finished."
