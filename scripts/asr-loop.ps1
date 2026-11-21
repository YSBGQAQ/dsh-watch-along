# Loop 12 times against the local ASR service.
# Keep this file ASCII-only: PS 5.1 reads .ps1 as ANSI (GBK),
# so a UTF-8 file without BOM turns Chinese into garbage and breaks parsing.
$ErrorActionPreference = 'Stop'
$body = '{"seconds":3}'
$uri = 'http://127.0.0.1:8766/listen'

for ($i = 1; $i -le 12; $i++) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json'
    $texts = @($r.lines | ForEach-Object { $_.text })
    if ($texts.Count -eq 0) { $shown = '(none)' } else { $shown = $texts -join ' || ' }
    if ($r.silent) { $tag = 'SILENT' } else { $tag = 'ok' }
    $line = '[{0,2}] {1,-6} total={2,5}s ms={3,6} | {4}' -f $i, $tag, $r.total, $r.ms, $shown
    Write-Output $line
  } catch {
    Write-Output ('[{0,2}] ERROR  {1}' -f $i, $_.Exception.Message)
    break
  }
  Start-Sleep -Milliseconds 800
}
Write-Output '---- done ----'
