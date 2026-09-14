$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot 'build/generated'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

function Write-PngIcon([string]$Path, [string]$Glyph, [System.Drawing.Color]$Background, [System.Drawing.Color]$Foreground) {
  $iconBitmap = New-Object System.Drawing.Bitmap 256,256
  $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
  $iconFont = New-Object System.Drawing.Font 'Microsoft YaHei',92,([System.Drawing.FontStyle]::Bold),([System.Drawing.GraphicsUnit]::Pixel)
  $iconBrush = New-Object System.Drawing.SolidBrush $Foreground
  $backgroundBrush = New-Object System.Drawing.SolidBrush $Background
  $pngStream = New-Object System.IO.MemoryStream
  try {
    $iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $iconGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $iconGraphics.Clear([System.Drawing.Color]::Transparent)
    $iconGraphics.FillRectangle($backgroundBrush, 0, 0, 256, 256)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $iconGraphics.DrawString($Glyph, $iconFont, $iconBrush, (New-Object System.Drawing.RectangleF 0,0,256,246), $format)
    $iconBitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $pngStream.ToArray()
    $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $writer = New-Object System.IO.BinaryWriter $file
    try {
      $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
      $writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0)
      $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22)
      $writer.Write($png)
    } finally { $writer.Dispose(); $file.Dispose() }
  } finally { $pngStream.Dispose(); $backgroundBrush.Dispose(); $iconBrush.Dispose(); $iconFont.Dispose(); $iconGraphics.Dispose(); $iconBitmap.Dispose() }
}

Write-PngIcon (Join-Path $outputDirectory 'app.ico') '千' ([System.Drawing.Color]::FromArgb(23,61,50)) ([System.Drawing.Color]::FromArgb(215,243,106))
Write-PngIcon (Join-Path $outputDirectory 'room.ico') '房' ([System.Drawing.Color]::FromArgb(34,91,73)) ([System.Drawing.Color]::FromArgb(235,250,243))
$bitmap = New-Object System.Drawing.Bitmap 600,260
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$titleFont = New-Object System.Drawing.Font 'Microsoft YaHei',28,([System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font 'Microsoft YaHei',12
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240,249,244))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(215,243,106))
try {
  $graphics.Clear([System.Drawing.Color]::FromArgb(23,61,50))
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.DrawString('千万间 Roomillion', $titleFont, $white, 40, 45)
  $graphics.DrawString('正在准备运行环境，请稍候…', $bodyFont, $white, 43, 113)
  $graphics.DrawString('首次启动需要解压资源，请不要重复打开。', $bodyFont, $white, 43, 151)
  $graphics.FillRectangle($accent, 43, 207, 514, 5)
  $bitmap.Save((Join-Path $outputDirectory 'startup.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $graphics.Dispose(); $bitmap.Dispose(); $titleFont.Dispose(); $bodyFont.Dispose(); $white.Dispose(); $accent.Dispose()
}
