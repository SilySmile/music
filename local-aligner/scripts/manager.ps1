param([ValidateSet('Prepare','Start','Stop','Status','Check','Configure')][string]$Action = 'Check')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRootItem = Get-Item -LiteralPath $taskRoot
if ($taskRootItem.LinkType -eq 'Junction') { $taskRoot = [IO.Path]::GetFullPath(@($taskRootItem.Target)[0]) }
$taskRuntime = Join-Path $taskRoot 'runtime'
$taskConfig = Join-Path $taskRuntime 'service.json'
$taskConnection = Join-Path $taskRuntime '播放器连接配置.json'
$taskPython = Join-Path $taskRuntime 'native-env/Scripts/python.exe'
$taskServer = Join-Path $taskRoot 'src/server.py'
$taskProcessFile = Join-Path $taskRuntime 'service-process.json'
function Read-Json([string]$File) { return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json([string]$File, $Value) { [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding $false)) }
function New-Connection {
    New-Item -ItemType Directory -Force -Path $taskRuntime,(Join-Path $taskRuntime 'logs'),(Join-Path $taskRuntime 'tmp'),(Join-Path $taskRuntime 'cache/pip') | Out-Null
    $defaults = Read-Json (Join-Path $taskRoot 'config.example.json')
    if (Test-Path -LiteralPath $taskConfig) { $value = Read-Json $taskConfig } else {
        $value = $defaults
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $value | Add-Member -NotePropertyName api_key -NotePropertyValue ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_'))
    }
    foreach ($property in $defaults.PSObject.Properties) {
        if (!$value.PSObject.Properties[$property.Name]) { $value | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value }
    }
    $value | Add-Member -NotePropertyName temp_dir -NotePropertyValue (Join-Path $taskRuntime 'tmp') -Force
    $value | Add-Member -NotePropertyName backend -NotePropertyValue 'transformers' -Force
    Write-Json $taskConfig $value
    Write-Json $taskConnection @{ format='xianqiji-local-aligner'; url="http://127.0.0.1:$($value.port)/v1"; model=$value.model_name; key=$value.api_key; automatic=$false; concurrency=2 }
}
function Set-PrivateEnvironment {
    $env:PIP_CACHE_DIR = Join-Path $taskRuntime 'cache/pip'
    $env:TEMP = Join-Path $taskRuntime 'tmp'; $env:TMP = $env:TEMP
    $env:HF_HOME = Join-Path $taskRuntime 'cache/huggingface'
    $env:HF_HUB_OFFLINE = '1'; $env:TRANSFORMERS_OFFLINE = '1'
    $env:PYTHONUTF8 = '1'; $env:PYTHONNOUSERSITE = '1'
    $env:OMP_NUM_THREADS = '4'; $env:MKL_NUM_THREADS = '4'
    $env:TOKENIZERS_PARALLELISM = 'false'
}
function Find-BasePython {
    foreach ($candidate in @(@('py.exe','-3.12'),@('py.exe','-3.11'),@('python.exe',''))) {
        if (!(Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
        $argsList = @(); if ($candidate[1]) { $argsList += $candidate[1] }
        $argsList += @('-c','import sys; assert sys.version_info[:2] in [(3,11),(3,12)]; print(sys.executable)')
        $result = & $candidate[0] @argsList 2>$null
        if ($LASTEXITCODE -eq 0 -and $result -and (Test-Path -LiteralPath ($result | Select-Object -Last 1))) { return ($result | Select-Object -Last 1) }
    }
    throw '未找到 Python 3.12/3.11。请安装 Windows 64 位 Python 3.12 后再次运行首次准备；安装地址见 README.md。'
}
function Run-Python([string[]]$Arguments) {
    & $taskPython @Arguments
    if ($LASTEXITCODE -ne 0) { throw "独立 Python 环境操作失败（$LASTEXITCODE），请查看上方输出和 runtime/logs/prepare.log。" }
}
function Get-OwnedProcess {
    if (!(Test-Path -LiteralPath $taskProcessFile)) { return $null }
    $state = Read-Json $taskProcessFile
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction SilentlyContinue
    if (!$process -or !$process.CommandLine -or !$state.instance) { return $null }
    $created = ([datetimeoffset]$process.CreationDate).ToUnixTimeMilliseconds() / 1000
    if ([Math]::Abs($created - [double]$state.created) -gt 2 -or !$process.CommandLine.Contains($state.instance) -or !$process.CommandLine.ToLowerInvariant().Contains($taskServer.ToLowerInvariant()) -or !$process.CommandLine.ToLowerInvariant().Contains($taskConfig.ToLowerInvariant())) { return $null }
    return $process
}
$taskTranscript = $false
$taskLock = $null
try {
    if ($Action -eq 'Configure') { New-Connection; Write-Host "本地连接配置已更新：$taskConnection（密钥保留，不在终端显示）"; exit 0 }
    if ($Action -eq 'Check') {
        Write-Host "Windows 原生部署目录：$taskRoot"
        & nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
        if (!(Test-Path -LiteralPath $taskPython)) { Write-Host '独立环境尚未准备，请运行 01-首次准备.cmd。不需要 WSL。'; exit 2 }
        Run-Python -Arguments @('-c',"import torch, qwen_asr, imageio_ffmpeg, fastapi, psutil; assert torch.cuda.is_available(), 'CUDA unavailable'; print('CUDA ready:', torch.cuda.get_device_name(0)); print('Audio tool:', imageio_ffmpeg.get_ffmpeg_exe())")
        exit 0
    }
    if ($Action -eq 'Prepare') {
        New-Connection
        $value = Read-Json $taskConfig
        foreach ($file in @('config.json','model.safetensors','tokenizer_config.json','preprocessor_config.json')) {
            if (!(Test-Path -LiteralPath (Join-Path $value.model_path $file))) { throw "模型文件不完整：$file。请检查 runtime/service.json 的 model_path。" }
        }
        Set-PrivateEnvironment
        Start-Transcript -Path (Join-Path $taskRuntime 'logs/prepare.log') -Append | Out-Null; $taskTranscript = $true
        if (!(Test-Path -LiteralPath $taskPython)) {
            $basePython = Find-BasePython
            & $basePython -m venv (Join-Path $taskRuntime 'native-env')
            if ($LASTEXITCODE -ne 0) { throw '创建独立 Python 环境失败。' }
        }
        Write-Host '准备 Windows 原生 CUDA 环境，不安装 WSL。首次需下载数 GB 依赖，全部放在本目录。'
        Run-Python -Arguments @('-m','pip','install','--upgrade','pip')
        Run-Python -Arguments @('-m','pip','install','torch==2.8.0','torchvision==0.23.0','torchaudio==2.8.0','--index-url','https://download.pytorch.org/whl/cu128')
        Run-Python -Arguments @('-m','pip','install','-r',(Join-Path $taskRoot 'requirements.txt'))
        Run-Python -Arguments @('-c',"import torch; from qwen_asr import Qwen3ForcedAligner; import imageio_ffmpeg; assert torch.cuda.is_available(), 'CUDA unavailable: check NVIDIA driver'; print('CUDA ready:', torch.cuda.get_device_name(0)); print(imageio_ffmpeg.get_ffmpeg_exe())")
        Write-Host "准备完成。双击 02-启动模型.cmd；播放器导入：$taskConnection"
        exit 0
    }
    if (!(Test-Path -LiteralPath $taskConfig)) { throw '请先运行 01-首次准备.cmd。' }
    $value = Read-Json $taskConfig
    $headers = @{ Authorization='Bearer ' + $value.api_key }
    $health = "http://127.0.0.1:$($value.port)/v1/health"
    if ($Action -eq 'Stop') {
        $owned = Get-OwnedProcess
        if (!$owned) { Write-Host '本目录的模型服务已停止。'; exit 0 }
        try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$($value.port)/v1/shutdown" -Method Post -Headers $headers -Body '{}' -ContentType 'application/json' -TimeoutSec 2 } catch { }
        $deadline = [datetime]::UtcNow.AddSeconds(6)
        while ((Get-OwnedProcess) -and [datetime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        $owned = Get-OwnedProcess
        if ($owned) { Stop-Process -Id $owned.ProcessId -Force; Start-Sleep -Milliseconds 500 }
        if (Get-OwnedProcess) { throw '模型进程未退出，请查看日志。' }
        Write-Host '本目录模型已停止，模型及其音频解码子进程退出，显存释放。'
        exit 0
    }
    if ($Action -eq 'Status') {
        $result = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 5
        Write-Host "模型：$($result.model)；就绪：$($result.ready)；可接任务：$($result.resource_ready)；活动歌曲：$($result.active)"
        if ($result.reason) { Write-Host $result.reason }; exit 0
    }
    if (!(Test-Path -LiteralPath $taskPython)) { throw '请先运行 01-首次准备.cmd，完成 Windows 原生环境安装。' }
    New-Connection; Set-PrivateEnvironment
    try { $taskLock = [IO.File]::Open((Join-Path $taskRuntime 'start.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { throw '启动脚本已在运行，请等待现有窗口的就绪提示。' }
    try { $existing = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 2 } catch { $existing = $null }
    if ($existing.service -eq 'xianqiji-forced-aligner' -and $existing.ready -and $existing.model -eq $value.model_name) { Write-Host '模型已经运行，不会重复加载。'; exit 0 }
    if (Get-OwnedProcess) { throw '本目录的模型正在加载或退出，请查看日志或先运行停止模型。' }
    $socket = New-Object Net.Sockets.TcpClient
    try {
        $connect = $socket.BeginConnect('127.0.0.1', [int]$value.port, $null, $null)
        $occupied = $connect.AsyncWaitHandle.WaitOne(300) -and $socket.Connected
    } catch { $occupied = $false } finally { $socket.Dispose() }
    if ($occupied) { throw '端口已被其他服务占用，请修改 runtime/service.json 的端口。' }
    $availableMB = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024
    if ($availableMB -lt 12288) { throw 'Windows 可用内存不足 12GB，请关闭占用较多的软件后启动模型。' }
    $gpu = & nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits
    if ($LASTEXITCODE -ne 0) { throw '无法读取 NVIDIA 显存，请检查显卡驱动。' }
    $parts = ($gpu | Select-Object -First 1) -split ','
    if ($parts.Length -ne 2 -or [double]$parts[1] -lt ([double]$parts[0] * .30 + $value.min_free_gpu_mb)) { throw '当前空闲显存不足以加载模型并保留余量，请关闭其他 GPU 软件。' }
    Write-Host '正在加载 Windows 原生 CUDA 模型，日志保存在 runtime/logs/server.log。'
    $instance = [guid]::NewGuid().ToString('N')
    $worker = Start-Process -FilePath $taskPython -ArgumentList @('-u',('"' + $taskServer + '"'),'--config',('"' + $taskConfig + '"'),'--instance',$instance) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'logs/server.log') -RedirectStandardError (Join-Path $taskRuntime 'logs/server-error.log')
    $workerHandle = $worker.Handle
    for ($attempt=0; $attempt -lt 90; $attempt++) {
        $worker.Refresh()
        if ($worker.HasExited) { throw '模型加载进程已退出，请查看 runtime/logs/server-error.log。' }
        try {
            $result = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 2
            if ($result.service -eq 'xianqiji-forced-aligner' -and $result.ready -and $result.model -eq $value.model_name) {
                Write-Host "模型已就绪：$($result.model)"
                Write-Host "地址：http://127.0.0.1:$($value.port)/v1"
                Write-Host "播放器导入：$taskConnection"
                if (!$result.resource_ready) { Write-Host "当前等待资源：$($result.reason)" }
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw '启动等待超时，请查看 runtime/logs/server-error.log；不会启动第二份模型。'
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
finally { if ($taskLock) { $taskLock.Dispose() }; if ($taskTranscript) { Stop-Transcript | Out-Null } }
