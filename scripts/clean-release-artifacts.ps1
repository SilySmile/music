param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $workspace 'release')).Path
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.release-staging'))
$current = Join-Path $releaseRoot "v$version"
foreach ($name in @("Xianqiji-Setup-$version-x64.exe", "Xianqiji-$version-x64.exe", "Xianqiji-$version-android.apk", 'SHA256SUMS.txt', 'manifest.json')) {
    if (!(Test-Path -LiteralPath (Join-Path $current $name) -PathType Leaf)) { throw "Current verified release is missing: $name" }
}
& node (Join-Path $PSScriptRoot 'verify-release.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Current release signature or package hashes are invalid; nothing has been removed.' }
if ((Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$releaseRoot\", [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'A release-directory player is running; exit it before cleanup.' }
$preserved = [Collections.Generic.List[string]]::new()
$removed = [Collections.Generic.List[object]]::new()
$skipped = [Collections.Generic.List[string]]::new()
$runtime = @('resources', 'locales', '弦栖霁.exe', '听屿音乐.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll')
$metadata = @('使用说明.txt', '更新说明.txt', '更新服务部署与发布指南.md', '音乐库切换使用说明.md', 'builder-debug.yml', 'SHA256SUMS.txt', 'update-notes.txt', '验证结果.json', 'manifest.json')
function Assert-ContainedItem([string]$Target) {
    $item = Get-Item -LiteralPath $Target -Force
    $absolute = $item.FullName
    $allowed = $absolute.StartsWith("$releaseRoot\", [StringComparison]::OrdinalIgnoreCase) -or $absolute.StartsWith("$stagingRoot\", [StringComparison]::OrdinalIgnoreCase)
    if (!$allowed -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe cleanup target: $absolute" }
    $ancestor = $item
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup path contains a link: $($ancestor.FullName)" }
        if ($ancestor.FullName -eq $releaseRoot -or $ancestor.FullName -eq $stagingRoot) { break }
        if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent }
        else { $ancestor = $ancestor.Directory }
    }
    return $item
}
function Assert-ArtifactPath([string]$Target) {
    $item = Assert-ContainedItem $Target
    $absolute = $item.FullName
    foreach ($protected in $preserved) {
        if ($absolute.Equals($protected, [StringComparison]::OrdinalIgnoreCase) -or $absolute.StartsWith("$protected\", [StringComparison]::OrdinalIgnoreCase) -or $protected.StartsWith("$absolute\", [StringComparison]::OrdinalIgnoreCase)) { throw "Cleanup would touch protected data: $absolute" }
    }
    return $item
}
function Remove-Artifact([string]$Target) {
    $item = Assert-ArtifactPath $Target
    $bytes = [long]0
    if ($item.PSIsContainer) {
        foreach ($entry in Get-ChildItem -LiteralPath $item.FullName -Recurse -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($entry.PSIsContainer -and $entry.Name -match '^Data($|[._-])')) { throw "Protected data or link found inside artifact: $($entry.FullName)" }
            if (!$entry.PSIsContainer) { $bytes += $entry.Length }
        }
    } else { $bytes = $item.Length }
    $removed.Add([pscustomobject]@{ path = $item.FullName; bytes = $bytes })
    if ($Apply) {
        if ($item.PSIsContainer) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
        else { Remove-Item -LiteralPath $item.FullName -Force }
    }
}
function Remove-Empty([string]$Directory) {
    if ($Apply -and (Test-Path -LiteralPath $Directory) -and !(Get-ChildItem -LiteralPath $Directory -Force)) {
        $item = Assert-ArtifactPath $Directory
        Remove-Item -LiteralPath $item.FullName -Force
    }
}
function Clean-Runtime([string]$Directory) {
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) { return }
    Assert-ContainedItem $Directory | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.Name -match '^Data($|[._-])') { continue }
        if ($item.Name -in $runtime) { Remove-Artifact $item.FullName }
        else { $skipped.Add($item.FullName) }
    }
    Remove-Empty $Directory
}
$versions = @(Get-ChildItem -LiteralPath $releaseRoot -Directory -Force | Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' })
foreach ($directory in $versions) {
    Assert-ContainedItem $directory.FullName | Out-Null
    foreach ($base in @($directory.FullName, (Join-Path $directory.FullName 'win-unpacked'))) {
        if (Test-Path -LiteralPath $base -PathType Container) {
            foreach ($data in Get-ChildItem -LiteralPath $base -Directory -Force | Where-Object { $_.Name -match '^Data($|[._-])' }) { $preserved.Add($data.FullName) }
        }
    }
}
$legacyRuntime = Join-Path $releaseRoot 'win-unpacked'
if (Test-Path -LiteralPath $legacyRuntime -PathType Container) {
    Assert-ContainedItem $legacyRuntime | Out-Null
    foreach ($data in Get-ChildItem -LiteralPath $legacyRuntime -Directory -Force | Where-Object { $_.Name -match '^Data($|[._-])' }) { $preserved.Add($data.FullName) }
}
foreach ($directory in $versions | Where-Object { $_.FullName -ne $current }) {
    foreach ($item in Get-ChildItem -LiteralPath $directory.FullName -Force) {
        if ($item.PSIsContainer -and $item.Name -eq 'win-unpacked') { Clean-Runtime $item.FullName }
        elseif ($item.PSIsContainer) { if ($item.FullName -notin $preserved) { $skipped.Add($item.FullName) } }
        elseif ($item.Name -match '^(Xianqiji|Tingyu-Music)-.*\.(exe|apk)(\.blockmap|\.idsig)?$' -or $item.Name -in $metadata -or $item.Name -match '^(横排|竖排|关闭方式|托盘菜单|小字号|路径设置).+\.png$') { Remove-Artifact $item.FullName }
        else { $skipped.Add($item.FullName) }
    }
    Remove-Empty $directory.FullName
}
Clean-Runtime (Join-Path $releaseRoot 'win-unpacked')
foreach ($item in Get-ChildItem -LiteralPath $releaseRoot -File -Force) {
    if ($item.Name -match '^(Xianqiji|Tingyu-Music)-.*\.(exe|apk)(\.blockmap|\.idsig)?$' -or $item.Name -in $metadata) { Remove-Artifact $item.FullName }
    else { $skipped.Add($item.FullName) }
}
Clean-Runtime (Join-Path $current 'win-unpacked')
foreach ($name in @('builder-debug.yml', "Xianqiji-Setup-$version-x64.exe.blockmap")) {
    $file = Join-Path $current $name
    if (Test-Path -LiteralPath $file) { Remove-Artifact $file }
}
if (Test-Path -LiteralPath $stagingRoot -PathType Container) {
    foreach ($item in Get-ChildItem -LiteralPath $stagingRoot -Force) {
        if (($item.PSIsContainer -and $item.Name -match '^v\d+\.\d+\.\d+$') -or (!$item.PSIsContainer -and $item.Name -match '^Xianqiji-update-\d+\.\d+\.\d+\.tar$')) { Remove-Artifact $item.FullName }
        else { $skipped.Add($item.FullName) }
    }
}
$report = [pscustomobject]@{ version = $version; applied = [bool]$Apply; removedBytes = ($removed | Measure-Object -Property bytes -Sum).Sum; artifacts = @($removed.ToArray()); protectedData = @($preserved.ToArray()); unknownPreserved = @($skipped.ToArray()) }
$destination = Join-Path $workspace 'test-results'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination "release-cleanup-$version.json") -Encoding utf8
[pscustomobject]@{ applied = [bool]$Apply; artifactCount = $removed.Count; freedGiB = [Math]::Round(($report.removedBytes / 1GB), 2); protectedData = @($preserved.ToArray()); unknownPreserved = @($skipped.ToArray()) } | ConvertTo-Json -Depth 4
