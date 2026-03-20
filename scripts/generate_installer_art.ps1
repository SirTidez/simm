$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot 'src-tauri\windows\assets'
$iconPath = Join-Path $repoRoot 'src\assets\app-icon-256.png'

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

function New-Brush([string]$hex) {
  return [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex))
}

function Draw-GradientBackground($graphics, $width, $height, [string]$topHex, [string]$bottomHex) {
  $rect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.ColorTranslator]::FromHtml($topHex),
    [System.Drawing.ColorTranslator]::FromHtml($bottomHex),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
  )
  $graphics.FillRectangle($brush, $rect)
  $brush.Dispose()
}

function Save-Bitmap($bitmap, [string]$path) {
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}

$iconImage = [System.Drawing.Image]::FromFile($iconPath)

$sidebarWidth = 164
$sidebarHeight = 314
$sidebar = [System.Drawing.Bitmap]::new($sidebarWidth, $sidebarHeight)
$g = [System.Drawing.Graphics]::FromImage($sidebar)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-GradientBackground $g $sidebarWidth $sidebarHeight '#08101A' '#16263C'
$g.FillEllipse((New-Brush '#102338'), 16, 20, 132, 132)
$g.FillEllipse((New-Brush '#1C3554'), 28, 32, 108, 108)
$g.DrawImage($iconImage, 40, 44, 84, 84)
$titleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 20, [System.Drawing.FontStyle]::Bold)
$subtitleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 9.5, [System.Drawing.FontStyle]::Regular)
$smallFont = [System.Drawing.Font]::new('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
$whiteBrush = New-Brush '#F3F7FF'
$mutedBrush = New-Brush '#A9BED8'
$accentBrush = New-Brush '#D9E9FF'
$lineBrush = New-Brush '#2C4567'
$sf = [System.Drawing.StringFormat]::new()
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Near
$g.DrawString('SIMM', $titleFont, $whiteBrush, [System.Drawing.RectangleF]::new(10, 160, 144, 34), $sf)
$g.DrawString('Schedule I Mod' + "`n" + 'Manager', $subtitleFont, $accentBrush, [System.Drawing.RectangleF]::new(6, 194, 152, 32), $sf)
$g.FillRectangle($lineBrush, 26, 228, 112, 1)
$g.DrawString('Your hub for', $smallFont, $mutedBrush, [System.Drawing.RectangleF]::new(12, 242, 140, 18), $sf)
$g.DrawString('the full Schedule I', $smallFont, $whiteBrush, [System.Drawing.RectangleF]::new(12, 258, 140, 18), $sf)
$g.DrawString('modding workflow', $smallFont, $whiteBrush, [System.Drawing.RectangleF]::new(12, 274, 140, 18), $sf)
$g.Dispose()
Save-Bitmap $sidebar (Join-Path $outputDir 'installer-sidebar.bmp')

$headerWidth = 150
$headerHeight = 57
$header = [System.Drawing.Bitmap]::new($headerWidth, $headerHeight)
$g = [System.Drawing.Graphics]::FromImage($header)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
Draw-GradientBackground $g $headerWidth $headerHeight '#101925' '#1A2434'
$g.DrawImage($iconImage, 8, 6, 44, 44)
$headerTitleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 16, [System.Drawing.FontStyle]::Bold)
$g.DrawString('SIMM', $headerTitleFont, $whiteBrush, 60, 13)
$g.Dispose()
Save-Bitmap $header (Join-Path $outputDir 'installer-header.bmp')

$iconImage.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$smallFont.Dispose()
$headerTitleFont.Dispose()
$whiteBrush.Dispose()
$mutedBrush.Dispose()
$accentBrush.Dispose()
$lineBrush.Dispose()
