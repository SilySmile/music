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
using System.Threading;
public class WslFixture {
  public static int Main(string[] args) {
    string log = Environment.GetEnvironmentVariable("XIANQIJI_FIXTURE_WSL_LOG");
    File.AppendAllText(log, string.Join("|", args) + "\n");
    Console.OutputEncoding = Encoding.Unicode;
    if(args.Length > 0 && args[0] == "--version") Console.WriteLine("WSL fixture 2.4.0");
    else if(args.Length > 0 && args[0] == "--list") Console.WriteLine("XianqijiAligner");
    else if(Array.IndexOf(args, "--install") >= 0) return 97;
    else if(Array.IndexOf(args, "--terminate") >= 0) File.WriteAllText(log + ".stop", "stop");
    else if(Array.Exists(args, arg => arg.EndsWith("/start.sh"))) {
      if(Environment.GetEnvironmentVariable("XIANQIJI_FIXTURE_WSL_FAIL") == "1") return 14;
      File.Delete(log + ".stop"); File.Delete(log + ".idle");
      File.WriteAllText(log + ".started", System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
      DateTime deadline = DateTime.UtcNow.AddSeconds(45);
      while(DateTime.UtcNow < deadline && !File.Exists(log + ".stop") && !File.Exists(log + ".idle")) Thread.Sleep(100);
    }
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
# Stub host resource probes and health HTTP inside the isolated copy as well.
$taskStubs = @'
function Get-CimInstance { return [pscustomobject]@{ FreePhysicalMemory=32 * 1024 * 1024 } }
function nvidia-smi { $global:LASTEXITCODE=0; return '8192,8192' }
function Invoke-RestMethod($Uri,$Headers,$TimeoutSec) {
    if (!(Test-Path -LiteralPath ($env:XIANQIJI_FIXTURE_WSL_LOG + '.started'))) { throw 'fixture not started' }
    return [pscustomobject]@{ service='xianqiji-forced-aligner'; ready=$true; model='qwen3-forced-aligner'; resource_ready=$true; active=0 }
}
'@
$taskManager = $taskManager.Replace('function New-Connection {', ($taskStubs + "`r`nfunction New-Connection {"))
$taskScript = Join-Path $taskCopy 'scripts/manager.ps1'
[IO.File]::WriteAllText($taskScript, $taskManager, (New-Object Text.UTF8Encoding $true))
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'config.example.json') -Raw | ConvertFrom-Json
$taskConfig.model_path = Join-Path $taskDirectory 'model'
[IO.File]::WriteAllText((Join-Path $taskCopy 'config.example.json'), ($taskConfig | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
foreach ($file in @('config.json','model.safetensors','tokenizer_config.json','preprocessor_config.json')) { [IO.File]::WriteAllText((Join-Path $taskConfig.model_path $file), '{}') }
foreach ($action in @('Configure','Prepare','Configure','Start','Status','Stop','Check')) {
    $process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $taskScript + '"'),'-Action',$action) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDirectory ($action + '.log')) -RedirectStandardError (Join-Path $taskDirectory ($action + '.err'))
    # Start-Process -Wait waits for descendants too; test closing only the launcher.
    $taskHandle = $process.Handle
    if (!$process.WaitForExit(15000)) { throw "Launcher did not return promptly: $action" }
    if ($process.ExitCode -ne 0) { throw "Launcher fixture failed: $action. See $taskDirectory" }
    $current = Get-Content -LiteralPath (Join-Path $taskCopy 'runtime/播放器连接配置.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($action -eq 'Configure' -and !$taskFirstKey) { $taskFirstKey = $current.key }
    if ($current.key -ne $taskFirstKey -or $current.key.Length -lt 32 -or $current.model -ne 'qwen3-forced-aligner') { throw 'Connection configuration was corrupted or regenerated unexpectedly' }
    if ($action -eq 'Start') {
        $taskWorkerId = [int][IO.File]::ReadAllText($env:XIANQIJI_FIXTURE_WSL_LOG + '.started')
        if (!(Get-Process -Id $taskWorkerId -ErrorAction SilentlyContinue)) { throw 'Hidden WSL client exited when launcher closed' }
    }
    if ($action -eq 'Stop') {
        Wait-Process -Id $taskWorkerId -Timeout 5 -ErrorAction SilentlyContinue
        if (Get-Process -Id $taskWorkerId -ErrorAction SilentlyContinue) { throw 'Hidden WSL client survived dedicated distribution stop' }
    }
}
# Simulate model idle exit independently of the launcher and explicit Stop.
Remove-Item -LiteralPath ($env:XIANQIJI_FIXTURE_WSL_LOG + '.started')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $taskScript -Action Start
if ($LASTEXITCODE -ne 0) { throw 'Second model start failed' }
$taskWorkerId = [int][IO.File]::ReadAllText($env:XIANQIJI_FIXTURE_WSL_LOG + '.started')
[IO.File]::WriteAllText(($env:XIANQIJI_FIXTURE_WSL_LOG + '.idle'), 'idle')
Wait-Process -Id $taskWorkerId -Timeout 5 -ErrorAction SilentlyContinue
if (Get-Process -Id $taskWorkerId -ErrorAction SilentlyContinue) { throw 'Hidden WSL client survived model idle exit' }
Remove-Item -LiteralPath ($env:XIANQIJI_FIXTURE_WSL_LOG + '.started')
$env:XIANQIJI_FIXTURE_WSL_FAIL = '1'
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $taskScript -Action Start
if ($LASTEXITCODE -ne 1 -or $taskWatch.Elapsed.TotalSeconds -gt 12) { throw 'Failed WSL launch did not report failure promptly' }
Remove-Item Env:XIANQIJI_FIXTURE_WSL_FAIL
$taskLinuxStart = [IO.File]::ReadAllText((Join-Path $taskRoot 'scripts/start.sh'))
if ($taskLinuxStart -notmatch 'exec systemd-run[^\r\n]*--wait') { throw 'WSL client must remain attached to the actual systemd model lifetime' }
$taskCalls = [IO.File]::ReadAllText($env:XIANQIJI_FIXTURE_WSL_LOG)
if ($taskCalls.Contains('--install') -or $taskCalls.Contains('--shutdown') -or !$taskCalls.Contains('--terminate|XianqijiAligner') -or !$taskCalls.Contains('--exec|bash|/mnt/')) { throw 'Unexpected WSL lifecycle arguments' }
Remove-Item Env:XIANQIJI_FIXTURE_WSL_LOG
Write-Host 'PASS isolated launcher fixtures: UTF-8/Chinese/spaced paths, stable local credentials, Prepare/Start/Status/Stop/Check, hidden client survives launcher, exits on stop/idle, early failure, dedicated WSL arguments; no real WSL install, no elevation, no GPU loading'
