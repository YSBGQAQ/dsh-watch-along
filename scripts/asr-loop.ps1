# 连打 12 次 /listen，每次间隔 0.8 秒，只打印"第几拍 + 这次新出了什么"。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File <本文件>
$ErrorActionPreference = 'Stop'
$body = '{"seconds":3}'
$uri = 'http://127.0.0.1:8766/listen'

for ($i = 1; $i -le 12; $i++) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json'
    $texts = @($r.lines | ForEach-Object { $_.text })
    $shown = if ($texts.Count -gt 0) { $texts -join ' ‖ ' } else { '（空）' }
    $tag = if ($r.silent) { 'SILENT' } else { 'ok' }
    Write-Output ("[{0,2}] {1,-6} total={2,5}s ms={3,6} | {4}" -f $i, $tag, $r.total, $r.ms, $shown)
  } catch {
    Write-Output ("[{0,2}] ERROR  {1}" -f $i, $_.Exception.Message)
    break
  }
  Start-Sleep -Milliseconds 800
}
Write-Output '---- 结束 ----'
