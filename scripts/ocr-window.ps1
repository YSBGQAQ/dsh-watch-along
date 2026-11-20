param(
  [Parameter(Mandatory=$true)][string]$Path,
  [double]$CropTop = 0,
  [double]$CropBottom = 1,
  [double]$Scale = 3.0,
  [int]$BandCount = 9,
  [double]$BandOverlap = 0.03,
  [int]$Retries = 2
)

# 分带全窗口 OCR。
#
# 为什么分带：整窗一次 OCR 会抛 "Cannot convert Object[] to Int32"；而
# vendor/dsh-streamvision-main/lib/ocr.ps1 那种窄带（10% 高）从来不出事。
# 所以这里按行切成 N 条带，逐条读，保留条带内行序 —— 行序就是阅读序，
# 做行级 diff 只需要"顺序 + 文本"，不需要像素坐标。
#
# 输出最后一行：JSON {...}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$OcrEngine = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$BitmapDecoder = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$StorageFile = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$ReadMode = [Windows.Storage.FileAccessMode]::Read
$engine = $OcrEngine::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'no OCR engine for user profile languages' }

$src = [System.Drawing.Image]::FromFile($Path)
$sw = $src.Width
$sh = $src.Height
$yStart = [int]($sh * $CropTop)
$yEnd = [int]($sh * $CropBottom)
$span = $yEnd - $yStart
if ($span -lt 8) { $span = 8 }
$bandH = [int][math]::Floor($span / $BandCount)
if ($bandH -lt 12) { $bandH = 12 }
$pad = [int]$BandOverlap

$bands = New-Object System.Collections.ArrayList
for ($by = $yStart; $by -lt $yEnd; $by += $bandH) {
  $bh = [Math]::Min($bandH, $yEnd - $by)
  $y0 = [Math]::Max(0, $by - $pad)
  $y1 = [Math]::Min($sh, $by + $bh + $pad)
  $rect = New-Object System.Drawing.Rectangle(0, $y0, $sw, ($y1 - $y0))
  $crop = $src.Clone($rect, $src.PixelFormat)
  $w2 = [int]($sw * $Scale)
  $h2 = [int](($y1 - $y0) * $Scale)
  $big = New-Object System.Drawing.Bitmap($w2, $h2)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($crop, 0, 0, $w2, $h2)
  $g.Dispose()
  $f = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("wbocr_" + [guid]::NewGuid().ToString('N') + ".png"))
  $big.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose(); $crop.Dispose()
  [void]$bands.Add([pscustomobject]@{ i = $bands.Count; file = $f; y0 = $y0 })
}
$src.Dispose()

$okCount = 0
$rows = New-Object System.Collections.ArrayList
$errs = New-Object System.Collections.ArrayList

foreach ($band in $bands) {
  $done = $false
  for ($attempt = 0; $attempt -le $Retries -and -not $done; $attempt++) {
    try {
      $file = Await ($StorageFile::GetFileFromPathAsync($band.file)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync($ReadMode)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ($BitmapDecoder::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      foreach ($line in $result.Lines) {
        $t = ([string]$line.Text).Trim()
        if ($t) { [void]$rows.Add([pscustomobject]@{ band = $band.i; y0 = $band.y0; text = $t }) }
      }
      $stream.Dispose()
      $okCount++
      $done = $true
    } catch {
      if ($errs.Count -lt 3) { [void]$errs.Add($_.Exception.Message) }
    }
  }
  Remove-Item $band.file -Force -ErrorAction SilentlyContinue
}

$json = [pscustomobject]@{
  ok      = $true
  size    = "${sw}x${sh}"
  bandH   = $bandH
  bands   = $bands.Count
  bandsOk = $okCount
  count   = $rows.Count
  rows    = @($rows)
  errors  = @($errs)
} | ConvertTo-Json -Depth 5 -Compress

$enc = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("wbocr_" + [guid]::NewGuid().ToString('N') + ".json"))
[System.IO.File]::WriteAllText($enc, $json, (New-Object System.Text.UTF8Encoding($false)))
[Console]::Out.Write("JSON ")
[Console]::Out.Write([System.IO.File]::ReadAllText($enc, [System.Text.Encoding]::UTF8))
[Console]::Out.Write("`n")
Remove-Item $enc -Force -ErrorAction SilentlyContinue
