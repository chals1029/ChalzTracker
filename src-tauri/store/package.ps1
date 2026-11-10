[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$MakeAppxPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tauriDir = Split-Path -Parent $PSScriptRoot
$repoDir = Split-Path -Parent $tauriDir
$config = Get-Content -LiteralPath (Join-Path $tauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "Tauri version must have three numeric components for MSIX: $version"
}
$components = $version.Split('.')
foreach ($component in $components) {
    if ([decimal]$component -gt 65535) { throw "MSIX version component exceeds 65535: $component" }
}
$packageVersion = "$version.0"
$exe = Join-Path $tauriDir 'target\release\chalztracker.exe'
$branding = Join-Path $repoDir 'assets\chalz-icon-192.png'
$manifestTemplate = Join-Path $PSScriptRoot 'AppxManifest.xml'
foreach ($path in @($exe, $branding, $manifestTemplate)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

if (-not $MakeAppxPath) {
    $command = Get-Command 'makeappx.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $MakeAppxPath = $command.Source }
    else {
        $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
            $sdk = Get-ChildItem -LiteralPath $kitsRoot -Directory | Where-Object {
                $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and
                (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\makeappx.exe') -PathType Leaf)
            } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
            if ($sdk) { $MakeAppxPath = Join-Path $sdk.FullName 'x64\makeappx.exe' }
        }
    }
}
if (-not $MakeAppxPath -or -not (Test-Path -LiteralPath $MakeAppxPath -PathType Leaf)) {
    throw 'MakeAppx.exe not found. Install the Windows SDK or pass -MakeAppxPath.'
}
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot "ChalzTracker_${packageVersion}_x64.msix" }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw "Output already exists: $OutputPath" }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $OutputPath) -PathType Container)) {
    throw "Output directory does not exist: $(Split-Path -Parent $OutputPath)"
}

# Check the PE machine type without executing or altering the prebuilt binary.
$stream = [System.IO.File]::OpenRead($exe)
$reader = New-Object System.IO.BinaryReader($stream)
try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Executable is not a PE file.' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 6) { throw 'Invalid PE header offset.' }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
        throw 'Executable must be an x64 PE binary.'
    }
} finally { $reader.Dispose() }

Add-Type -AssemblyName System.Drawing
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("ChalzTracker-MSIX-" + [guid]::NewGuid().ToString('N'))
$stageCreated = $false
try {
    $null = New-Item -ItemType Directory -Path $stage
    $stageCreated = $true
    $null = New-Item -ItemType Directory -Path (Join-Path $stage 'Assets'), (Join-Path $stage 'frontend')
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'chalztracker.exe')
    foreach ($file in @('index.html', 'app.js', 'styles.css', 'manifest.webmanifest')) {
        Copy-Item -LiteralPath (Join-Path $repoDir $file) -Destination (Join-Path $stage "frontend\$file")
    }
    Copy-Item -LiteralPath (Join-Path $repoDir 'assets') -Destination (Join-Path $stage 'frontend\assets') -Recurse

    $source = [System.Drawing.Image]::FromFile($branding)
    try {
        foreach ($asset in @(@('StoreLogo.png', 50), @('Square150x150Logo.png', 150), @('Square44x44Logo.png', 44))) {
            $bitmap = New-Object System.Drawing.Bitmap([int]$asset[1], [int]$asset[1])
            try {
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                try {
                    $graphics.Clear([System.Drawing.Color]::Transparent)
                    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $graphics.DrawImage($source, 0, 0, [int]$asset[1], [int]$asset[1])
                } finally { $graphics.Dispose() }
                $bitmap.Save((Join-Path $stage "Assets\$($asset[0])"), [System.Drawing.Imaging.ImageFormat]::Png)
            } finally { $bitmap.Dispose() }
        }
    } finally { $source.Dispose() }

    $manifest = (Get-Content -LiteralPath $manifestTemplate -Raw).Replace('__PACKAGE_VERSION__', $packageVersion)
    [System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))
    & $MakeAppxPath pack /d $stage /p $OutputPath
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE; inspect the output path before retrying." }
    Write-Host "Unsigned MSIX created: $OutputPath"
} finally {
    if ($stageCreated -and (Test-Path -LiteralPath $stage -PathType Container)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
