$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$logoPath = Join-Path $projectRoot 'public\restaurantos-mark.png'
$pngPath = Join-Path $projectRoot 'electron\assets\app-icon.png'
$icoPath = Join-Path $projectRoot 'build\icon.ico'

if (-not (Test-Path -LiteralPath $logoPath)) {
  throw "RestaurantOS logo not found: $logoPath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pngPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $icoPath) | Out-Null

$source = [System.Drawing.Image]::FromFile($logoPath)
$canvas = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)

try {
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $destination = [System.Drawing.Rectangle]::new(0, 0, 512, 512)
  $sourceBounds = [System.Drawing.Rectangle]::new(0, 0, $source.Width, $source.Height)
  $graphics.DrawImage($source, $destination, $sourceBounds, [System.Drawing.GraphicsUnit]::Pixel)
  $canvas.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $canvas.Dispose()
  $source.Dispose()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[byte[]]]::new()
$appIcon = [System.Drawing.Image]::FromFile($pngPath)

try {
  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $frameGraphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = [System.IO.MemoryStream]::new()
    try {
      $frameGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $frameGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $frameGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $frameGraphics.DrawImage($appIcon, 0, 0, $size, $size)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames.Add($stream.ToArray())
    } finally {
      $stream.Dispose()
      $frameGraphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $appIcon.Dispose()
}

$output = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($output)
try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$frames.Count)

  $imageOffset = 6 + (16 * $frames.Count)
  for ($index = 0; $index -lt $frames.Count; $index++) {
    $size = $sizes[$index]
    $bytes = $frames[$index]
    $dimension = if ($size -eq 256) { [byte]0 } else { [byte]$size }
    $writer.Write($dimension)
    $writer.Write($dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$imageOffset)
    $imageOffset += $bytes.Length
  }

  foreach ($frame in $frames) {
    $writer.Write($frame)
  }
} finally {
  $writer.Dispose()
  $output.Dispose()
}

Write-Output "Created $pngPath"
Write-Output "Created $icoPath"
