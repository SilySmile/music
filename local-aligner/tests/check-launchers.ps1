$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDirectory = Join-Path $taskRoot ('runtime/launcher-test-' + [guid]::NewGuid().ToString('N'))
$taskCopy = Join-Path $taskDirectory '部署 with spaces'
New-Item -ItemType Directory -Force -Path (Join-Path $taskCopy 'scripts'),(Join-Path $taskDirectory 'model') | Out-Null
$taskExe = Join-Path $taskDirectory 'mock-wsl.exe'
$env:XIANQIJI_FIXTURE_WSL_LOG = Join-Path $taskDirectory 'wsl-calls.log'
$taskSource = @'
using System;
using System.IO;
using System.Text;
public class WslFixture {
  public static int Main(string[] args) {
    File.AppendAllText(Environment.GetEnvironmentVariable("XIANQIJI_FIXTURE_WSL_LOG"), string.Join("|", args) + "\n");
    Console.OutputEncoding = Encoding.Unicode;
    if(args.Length > 0 && args[0] == "--version") Console.WriteLine("WSL fixture 2.4.0");
    else if(args.Length > 0 && args[0] == "--list") Console.WriteLine("XianqijiAligner");
    else if(Array.IndexOf(args, "--install") >= 0) return 97;
    return 0;
  }
}
'@
Add-Type -TypeDefinition $taskSource -OutputAssembly $taskExe -OutputType ConsoleApplication
# Replace every WSL execution point in an isolated copy before running it.
# This test must never call the real WSL installer or show an elevation prompt.
$taskManager = [IO.File]::ReadAllText((Join-Path $taskRoot 'scripts/manager.ps1'))
$taskLiteral = "'" + $taskExe.Replace("'", "''") + "'"
$taskManager = $taskManager.Replace("'wsl.exe'", $taskLiteral).Replace('& wsl.exe', ('& ' + $taskLiteral)).Replace('-FilePath wsl.exe', ('-FilePath ' + $taskLiteral))
if ($taskManager.Contains('& wsl.exe') -or $taskManager.Contains('-FilePath wsl.exe') -or $taskManager.Contains("'wsl.exe'")) { throw 'Unsafe unpatched WSL reference in test fixture' }
$taskScript = Join-Path $taskCopy 'scripts/manager.ps1'
[IO.File]::WriteAllText($taskScript, $taskManager, (New-Object Text.UTF8Encoding $true))
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'config.example.json') -Raw | ConvertFrom-Json
$taskConfig.model_path = Join-Path $taskDirectory 'model'
[IO.File]::WriteAllText((Join-Path $taskCopy 'config.example.json'), ($taskConfig | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
foreach ($file in @('config.json','model.safetensors','tokenizer_config.json','preprocessor_config.json')) { [IO.File]::WriteAllText((Join-Path $taskConfig.model_path $file), '{}') }
foreach ($action in @('Configure','Prepare','Configure','Stop','Check')) {
    $process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $taskScript + '"'),'-Action',$action) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $taskDirectory ($action + '.log')) -RedirectStandardError (Join-Path $taskDirectory ($action + '.err'))
    if ($process.ExitCode -ne 0) { throw "Launcher fixture failed: $action. See $taskDirectory" }
    $current = Get-Content -LiteralPath (Join-Path $taskCopy 'runtime/播放器连接配置.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($action -eq 'Configure' -and !$taskFirstKey) { $taskFirstKey = $current.key }
    if ($current.key -ne $taskFirstKey -or $current.key.Length -lt 32 -or $current.model -ne 'qwen3-forced-aligner') { throw 'Connection configuration was corrupted or regenerated unexpectedly' }
}
$taskCalls = [IO.File]::ReadAllText($env:XIANQIJI_FIXTURE_WSL_LOG)
if ($taskCalls.Contains('--install') -or $taskCalls.Contains('--shutdown') -or !$taskCalls.Contains('--terminate|XianqijiAligner') -or !$taskCalls.Contains('--exec|bash|/mnt/')) { throw 'Unexpected WSL lifecycle arguments' }
Remove-Item Env:XIANQIJI_FIXTURE_WSL_LOG
Write-Host 'PASS isolated launcher fixtures: UTF-8/Chinese/spaced paths, stable local credentials, Prepare/Stop/Check, explicit dedicated distribution and argument forwarding; no real WSL install, no elevation, no GPU loading'
