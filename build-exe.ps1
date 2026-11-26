param(
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = $PSScriptRoot
$icoPath = Join-Path $dir 'agent-room.ico'
$csPath = Join-Path $dir 'launcher.cs'
$exePath = Join-Path $dir 'Agent Room.exe'

if (-not (Test-Path -LiteralPath $csPath -PathType Leaf)) {
    throw "Missing launcher source: $csPath"
}

function New-LogoBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [float]($size * 0.06)
    $w = [float]($size - 2 * $pad)
    $r = [float]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($pad, $pad, $r, $r, 180, 90)
    $path.AddArc($pad + $w - $r, $pad, $r, $r, 270, 90)
    $path.AddArc($pad + $w - $r, $pad + $w - $r, $r, $r, 0, 90)
    $path.AddArc($pad, $pad + $w - $r, $r, $r, 90, 90)
    $path.CloseFigure()

    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($size, $size)),
        [System.Drawing.Color]::FromArgb(255, 22, 27, 44),
        [System.Drawing.Color]::FromArgb(255, 13, 16, 26)
    )
    $g.FillPath($bgBrush, $path)
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 124, 156, 255), [Math]::Max(1.0, $size * 0.03))
    $g.DrawPath($borderPen, $path)

    $p1 = New-Object System.Drawing.PointF(($size * 0.50), ($size * 0.28))
    $p2 = New-Object System.Drawing.PointF(($size * 0.29), ($size * 0.66))
    $p3 = New-Object System.Drawing.PointF(($size * 0.71), ($size * 0.66))
    $linkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 180, 198, 255), [Math]::Max(1.2, $size * 0.045))
    $g.DrawLine($linkPen, $p1, $p2)
    $g.DrawLine($linkPen, $p2, $p3)
    $g.DrawLine($linkPen, $p3, $p1)

    $nr = [float]($size * 0.125)
    $colors = @(
        [System.Drawing.Color]::FromArgb(255, 110, 168, 255),
        [System.Drawing.Color]::FromArgb(255, 240, 162, 122),
        [System.Drawing.Color]::FromArgb(255, 143, 209, 111)
    )
    $pts = @($p1, $p2, $p3)
    for ($i = 0; $i -lt 3; $i++) {
        $b = New-Object System.Drawing.SolidBrush($colors[$i])
        $g.FillEllipse($b, $pts[$i].X - $nr, $pts[$i].Y - $nr, $nr * 2, $nr * 2)
        $b.Dispose()
    }

    $bgBrush.Dispose(); $borderPen.Dispose(); $linkPen.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

$sizes = @(16, 32, 48, 256)
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-LogoBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,$ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
}

$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -eq 256) { [byte]0 } else { [byte]$sizes[$i] }
    $bw.Write($dim); $bw.Write($dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close(); $fs.Close()
Write-Output "Built: $icoPath ($((Get-Item -LiteralPath $icoPath).Length) bytes)"

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    throw '.NET Framework csc.exe not found.'
}

& $csc /nologo /target:winexe /optimize+ "/win32icon:$icoPath" "/out:$exePath" $csPath
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
Write-Output "Built: $exePath ($((Get-Item -LiteralPath $exePath).Length) bytes)"

if ($Check) {
    $p = Start-Process -FilePath $exePath -ArgumentList '-Check' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Agent Room.exe -Check failed with exit code $($p.ExitCode)" }
    Write-Output "Check OK (exit 0)"
}
