param(
  [Parameter(Mandatory=$true)][ValidateSet('Stage','Apply','Broker')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$WorkDir,
  [string]$Archive,
  [string]$Version,
  [string]$InstallDir,
  [string]$DataDir,
  [int]$ParentId,
  [string]$ResultFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [IO.File]::WriteAllText((Join-Path $WorkDir ("helper-entry-$Mode.log")), "script=$PSCommandPath`r`nmode=$Mode`r`npid=$PID`r`nparent=$ParentId")
} catch { }

function Assert-SafePath([string]$root, [string]$relative) {
  if (!$relative -or $relative.Contains('\') -or $relative.Contains(':')) { throw "Invalid archive path: $relative" }
  $parts = $relative.Split('/')
  foreach ($part in $parts) {
    if (!$part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw "Invalid archive path: $relative" }
  }
  $full = [IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
  if (!$full.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes destination: $relative" }
  return $full
}
function Assert-NoReparse([string]$root, [string]$target) {
  $current = [IO.Path]::GetFullPath($root).TrimEnd('\')
  if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in destination: $current" }
  $suffix = $target.Substring($current.Length).TrimStart('\')
  foreach ($part in $suffix.Split('\')) {
    if (!$part) { continue }
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in destination: $current" }
    }
  }
}
function Test-KnownReleasePath([string]$relative) {
  $top = $relative.Split('/')[0]
  $rootFiles = @('ChalzTracker.exe','ChalzTracker.cs','server.js','main.js','preload.js','updater.js','updater-helper.ps1','app.js','index.html','styles.css','package.json','README.md','LICENSE','brand-runtime.py','build-exe.cmd','app.manifest','manifest.webmanifest','launch.vbs','launch.cmd')
  return $top -in @('assets','lib','dist-app','Features') -or (!$relative.Contains('/') -and $top -in $rootFiles)
}
function Write-Result([string]$status, [string]$message) {
  @{ status = $status; message = $message; version = $Version } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
}

if ($Mode -eq 'Broker') {
  $launch = Get-Content -LiteralPath (Join-Path $WorkDir 'apply-launch.json') -Raw | ConvertFrom-Json
  if (!$launch.commandLine -or $launch.commandLine -isnot [string]) { throw 'Invalid update helper command.' }
  try {
    $environment = [string[]]@(Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
      EnvironmentVariables = $environment
      CreateFlags = [uint32]1024
      ShowWindow = [uint16]0
    }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = $launch.commandLine
      CurrentDirectory = $WorkDir
      ProcessStartupInformation = $startup
    }
  } catch { throw 'Windows could not start the update helper through WMI.' }
  if ($result.ReturnValue -ne 0 -or !$result.ProcessId) { throw "Windows could not start the update helper (WMI error $($result.ReturnValue))." }
  @{ pid = $result.ProcessId } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $WorkDir 'apply-broker.json') -Encoding UTF8
  return
}

if ($Mode -eq 'Stage') {
  $stage = Join-Path $WorkDir 'stage'
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $total = [long]0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if (!$name.StartsWith('ChalzTracker/', [StringComparison]::Ordinal) -or $name.Contains('\')) { throw "Unexpected archive entry: $name" }
      $relative = $name.Substring('ChalzTracker/'.Length).TrimEnd('/')
      if (!$relative) { continue }
      $target = Assert-SafePath $stage $relative
      if (!$seen.Add($relative)) { throw "Duplicate archive path: $relative" }
      $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
      if (($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000) -or ($entry.ExternalAttributes -band 0x400)) { throw "Unsupported archive entry: $name" }
      $total += $entry.Length
      if ($total -gt 2GB -or $zip.Entries.Count -gt 20000) { throw 'Archive exceeds extraction limits.' }
      if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      $input = $entry.Open()
      try {
        $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
      } finally { $input.Dispose() }
    }
  } finally { $zip.Dispose() }
  foreach ($file in @('ChalzTracker.exe','main.js','preload.js','server.js','app.js','index.html','styles.css','package.json','updater.js','updater-helper.ps1','dist-app/ChalzTracker-desktop.exe','assets/favicon.ico','lib/vault.js')) {
    if (!(Test-Path -LiteralPath (Assert-SafePath $stage $file) -PathType Leaf)) { throw "Release is missing $file" }
  }
  $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ($package.name -ne 'chalztracker' -or $package.version -ne $Version) { throw 'Release package name or version does not match.' }
  return
}

$stage = Join-Path $WorkDir 'stage'
$backup = Join-Path $WorkDir 'backup'
$journal = New-Object 'System.Collections.Generic.List[object]'
$createdDirectories = New-Object 'System.Collections.Generic.List[string]'
$inventoryChanged = $false
$inventoryTemp = $null
$inventoryBackup = Join-Path $WorkDir 'ownership-backup.json'
$replaceBackup = $null
try {
  [IO.File]::WriteAllText((Join-Path $WorkDir 'apply-ready.tmp'), "$PID")
  [IO.File]::Move((Join-Path $WorkDir 'apply-ready.tmp'), (Join-Path $WorkDir 'apply-ready'))
  $process = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
  if ($process) { $process.WaitForExit(120000); if (!$process.HasExited) { throw 'The app did not exit in time.' } }
  if (Test-Path -LiteralPath (Join-Path $WorkDir 'apply-cancel')) { exit 1 }
  $install = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $data = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
  $inventory = Join-Path $data 'update-owned-files.json'
  Assert-NoReparse $data $inventory
  $owned = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if (Test-Path -LiteralPath $inventory -PathType Leaf) {
    try {
      if ((Get-Item -LiteralPath $inventory).Length -gt 2MB) { throw 'Ownership inventory is too large.' }
      $document = Get-Content -LiteralPath $inventory -Raw | ConvertFrom-Json
      if ($document.schema -ne 1 -or $document.install -isnot [string] -or !$document.install.Equals($install, [StringComparison]::OrdinalIgnoreCase) -or $document.files -isnot [array] -or $document.files.Count -gt 20000) { throw 'Invalid ownership inventory.' }
      foreach ($entry in $document.files) {
        if ($entry -isnot [string]) { throw 'Invalid ownership inventory path.' }
        $null = Assert-SafePath $install $entry
        if (!$owned.Add($entry)) { throw 'Duplicate ownership inventory path.' }
      }
    } catch { $owned.Clear() }
  }
  $files = Get-ChildItem -LiteralPath $stage -File -Recurse -Force
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($stage.Length).TrimStart('\').Replace('\','/')
    $target = Assert-SafePath $install $relative
    if ($target.Equals($data, [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($data + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The update would overwrite the data directory.' }
    Assert-NoReparse $install $target
    if (!(Test-KnownReleasePath $relative) -and !$owned.Contains($relative) -and (Test-Path -LiteralPath $target)) { throw "An unrecognized existing file conflicts with the update: $target" }
    if (Test-Path -LiteralPath $target -PathType Container) { throw "A directory conflicts with an update file: $target" }
  }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($stage.Length).TrimStart('\').Replace('\','/')
    $target = Assert-SafePath $install $relative
    Assert-NoReparse $install $target
    $saved = Assert-SafePath $backup $relative
    $existed = Test-Path -LiteralPath $target -PathType Leaf
    if ($existed -and !(Test-KnownReleasePath $relative) -and !$owned.Contains($relative)) { throw "An unrecognized existing file conflicts with the update: $target" }
    if ($existed) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
      [IO.File]::Copy($target, $saved, $false)
    }
    $parent = [IO.Path]::GetDirectoryName($target)
    $missing = New-Object 'System.Collections.Generic.List[string]'
    while (!(Test-Path -LiteralPath $parent)) {
      $missing.Add($parent)
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
    for ($i = $missing.Count - 1; $i -ge 0; $i--) {
      [IO.Directory]::CreateDirectory($missing[$i]) | Out-Null
      $createdDirectories.Add($missing[$i])
    }
    if ($existed) {
      $journal.Add(@{ target = $target; saved = $saved; existed = $true })
      [IO.File]::Copy($file.FullName, $target, $true)
    } else {
      $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $journal.Add(@{ target = $target; saved = $saved; existed = $false })
        $input = [IO.File]::OpenRead($file.FullName)
        try { $input.CopyTo($output) } finally { $input.Dispose() }
      } finally { $output.Dispose() }
    }
    if (!(Test-KnownReleasePath $relative)) { $null = $owned.Add($relative) }
  }
  Assert-NoReparse $data $inventory
  $inventoryExisted = Test-Path -LiteralPath $inventory -PathType Leaf
  if ($inventoryExisted) { [IO.File]::Copy($inventory, $inventoryBackup, $false) }
  $inventoryTemp = Join-Path $data ('.update-owned-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $json = @{ schema = 1; install = $install; files = [string[]]@($owned) } | ConvertTo-Json -Compress
  $stream = [IO.File]::Open($inventoryTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
    try { $writer.Write($json) } finally { $writer.Dispose() }
  } finally { $stream.Dispose() }
  if ($inventoryExisted) {
    $replaceBackup = Join-Path $data ('.update-owned-backup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::Replace($inventoryTemp, $inventory, $replaceBackup)
  }
  else { [IO.File]::Move($inventoryTemp, $inventory) }
  $inventoryChanged = $true
  $inventoryTemp = $null
  Write-Result 'success' "ChalzTracker updated to $Version."
  if ($replaceBackup) { try { [IO.File]::Delete($replaceBackup) } catch { } }
  foreach ($item in @('release.zip','stage','backup','ownership-backup.json')) {
    try { Remove-Item -LiteralPath (Join-Path $WorkDir $item) -Recurse -Force -ErrorAction Stop } catch { }
  }
  try { Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction Stop } catch { }
} catch {
  $failure = $_.Exception.Message
  $rollbackErrors = New-Object 'System.Collections.Generic.List[string]'
  if ($inventoryTemp) { try { [IO.File]::Delete($inventoryTemp) } catch { $rollbackErrors.Add($_.Exception.Message) } }
  if ($inventoryChanged) {
    try {
      if ($inventoryExisted) { [IO.File]::Copy($inventoryBackup, $inventory, $true) }
      else { [IO.File]::Delete($inventory) }
    } catch { $rollbackErrors.Add($_.Exception.Message) }
  }
  if ($replaceBackup -and !$rollbackErrors.Count) { try { [IO.File]::Delete($replaceBackup) } catch { } }
  for ($i = $journal.Count - 1; $i -ge 0; $i--) {
    $item = $journal[$i]
    try {
      if ($item.existed) { [IO.File]::Copy($item.saved, $item.target, $true) }
      elseif (Test-Path -LiteralPath $item.target) { [IO.File]::Delete($item.target) }
    } catch { $rollbackErrors.Add($_.Exception.Message) }
  }
  for ($i = $createdDirectories.Count - 1; $i -ge 0; $i--) {
    try { [IO.Directory]::Delete($createdDirectories[$i], $false) }
    catch { $rollbackErrors.Add($_.Exception.Message) }
  }
  $message = "Update failed: $failure"
  if ($rollbackErrors.Count) { $message += " Rollback also failed: $($rollbackErrors -join '; '). Backups are in $backup." }
  else { $message += ' Changes were rolled back.' }
  try { Write-Result 'error' $message } catch { }
  try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($message, 'ChalzTracker update') | Out-Null } catch { }
  if ($rollbackErrors.Count) { exit 1 }
}
$env:CHALZTRACKER_HOME = $DataDir
try { Start-Process -FilePath (Join-Path $InstallDir 'ChalzTracker.exe') -WorkingDirectory $InstallDir } catch {
  try { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show("Could not restart ChalzTracker: $($_.Exception.Message)", 'ChalzTracker update') | Out-Null } catch { }
}
