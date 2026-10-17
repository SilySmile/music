$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPython = Join-Path $taskRoot 'runtime/native-env/Scripts/python.exe'
if (!(Test-Path -LiteralPath $taskPython)) { $taskPython = Join-Path $taskRoot 'runtime/test-env/Scripts/python.exe' }
& $taskPython (Join-Path $PSScriptRoot 'test_launcher.py')
if ($LASTEXITCODE -ne 0) { throw 'Windows 原生启停回归失败；详见 runtime/native-launcher-* 中的日志。' }
Write-Host 'PASS Windows native lifecycle: real local HTTP, Chinese/spaced paths, stable keys, detached launch, duplicate mutex, owned stop, unrelated/reused PID protection, idle exit and early failure; no real model loading'
