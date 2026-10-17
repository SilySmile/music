param([ValidateSet('Prepare','Start','Stop','Status','Check','Configure')][string]$Action = 'Check')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRuntime = Join-Path $taskRoot 'runtime'
$taskDistro = 'XianqijiAligner'
$taskConfig = Join-Path $taskRuntime 'service.json'
$taskConnection = Join-Path $taskRuntime '播放器连接配置.json'
function LinuxPath([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if ($full -notmatch '^([a-zA-Z]):[\\/](.*)$') { throw '请将部署目录放在本机盘符下。' }
    return '/mnt/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2].Replace('\','/')
}
function Read-Json([string]$File) { return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json([string]$File, $Value) {
    [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding $false))
}
function Probe-Wsl([string]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'wsl.exe'; $info.Arguments = $Arguments
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::Unicode
    $info.StandardErrorEncoding = [Text.Encoding]::Unicode
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(10000)) { $process.Kill(); throw 'WSL 状态检查超时，请检查 Windows 的 WSL 安装状态。' }
    $result = [pscustomobject]@{ Code=$process.ExitCode; Text=$stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult() }
    $process.Dispose()
    return $result
}
function Has-Wsl { return (Probe-Wsl '--version').Code -eq 0 }
function Has-Distro {
    $probe = Probe-Wsl '--list --quiet'
    return $probe.Code -eq 0 -and ($probe.Text.Replace([string][char]0,'') -split '\r?\n' | ForEach-Object { $_.Trim() }) -contains $taskDistro
}
function Call-Wsl([string[]]$Arguments) {
    & wsl.exe --distribution $taskDistro --user root --exec @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL 命令失败（$LASTEXITCODE）。请查看上方提示和 runtime/logs。" }
}
function New-Connection {
    New-Item -ItemType Directory -Force -Path $taskRuntime,(Join-Path $taskRuntime 'logs'),(Join-Path $taskRuntime 'tmp'),(Join-Path $taskRuntime 'downloads') | Out-Null
    if (!(Test-Path -LiteralPath $taskConfig)) {
        $value = Read-Json (Join-Path $taskRoot 'config.example.json')
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $value | Add-Member -NotePropertyName api_key -NotePropertyValue ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_'))
        $value | Add-Member -NotePropertyName temp_dir -NotePropertyValue (LinuxPath (Join-Path $taskRuntime 'tmp'))
        Write-Json $taskConfig $value
    }
    $value = Read-Json $taskConfig
    Write-Json $taskConnection @{ format='xianqiji-local-aligner'; url="http://127.0.0.1:$($value.port)/v1"; model=$value.model_name; key=$value.api_key; automatic=$false; concurrency=2 }
}
try {
    if ($Action -eq 'Configure') {
        New-Connection
        Write-Host "本地连接配置已生成：$taskConnection（密钥不在终端显示）"
        exit 0
    }
    if ($Action -eq 'Check') {
        Write-Host "部署目录：$taskRoot"
        Write-Host "模型目录：$((Read-Json (Join-Path $taskRoot 'config.example.json')).model_path)"
        & nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
        if (!(Has-Wsl)) { Write-Host 'WSL 尚未安装：先运行 01-首次准备.cmd；可能需要重启后再运行一次。'; exit 2 }
        if (!(Has-Distro)) { Write-Host '专用 Linux 环境尚未准备：请运行 01-首次准备.cmd。'; exit 2 }
        Write-Host 'WSL 专用环境已找到。'; exit 0
    }
    if ($Action -eq 'Prepare') {
        New-Connection
        if (!(Has-Wsl)) {
            Write-Host 'vLLM 需要 WSL2。下面仅安装 Windows WSL 组件，不自动重启。'
            $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if (!$admin) {
                $child = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Action','Prepare')
                if ($child.ExitCode -ne 0) { throw 'WSL 初次安装失败，请查看 runtime/logs/wsl-install.log 和 Windows 虚拟化提示。' }
                Write-Host '若 Windows 提示需要重启，请重启后再次双击首次准备。'; exit 0
            }
            $bootstrap = Start-Process -FilePath wsl.exe -ArgumentList @('--install','--no-distribution','--no-launch') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'logs/wsl-install.log') -RedirectStandardError (Join-Path $taskRuntime 'logs/wsl-install-error.log')
            if ($bootstrap.ExitCode -notin @(0,3010)) { throw 'WSL 安装未完成，请根据 runtime/logs/wsl-install-error.log 检查虚拟化支持。' }
            Write-Host 'WSL 组件已提交安装。请按 Windows 提示重启，然后再次运行首次准备。'
            exit 0
        }
        New-Connection
        $value = Read-Json $taskConfig
        foreach ($file in @('config.json','model.safetensors','tokenizer_config.json','preprocessor_config.json')) {
            if (!(Test-Path -LiteralPath (Join-Path $value.model_path $file))) { throw "模型文件不完整：$file。仅修改 runtime/service.json 中的 model_path，不要移动原模型。" }
        }
        if (!(Has-Distro)) {
            $imageName = 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
            $image = Join-Path $taskRuntime "downloads/$imageName"
            $base = 'https://cloud-images.ubuntu.com/wsl/releases/noble/current/'
            Write-Host '下载官方 Ubuntu WSL 镜像并核对 SHA-256，所有文件保存到本目录 runtime。'
            $sums = (Invoke-WebRequest -Uri ($base + 'SHA256SUMS') -UseBasicParsing).Content
            $match = [regex]::Match($sums, '(?m)^([a-f0-9]{64})\s+\*?' + [regex]::Escape($imageName) + '\s*$')
            if (!$match.Success) { throw 'Ubuntu 官方校验列表中未找到镜像，停止安装。' }
            if (!(Test-Path -LiteralPath $image) -or (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) {
                Invoke-WebRequest -Uri ($base + $imageName) -OutFile $image -UseBasicParsing
            }
            if ((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Ubuntu 镜像校验失败，请重新运行准备。' }
            $disk = Join-Path $taskRuntime 'wsl'
            New-Item -ItemType Directory -Force -Path $disk | Out-Null
            & wsl.exe --import $taskDistro $disk $image --version 2
            if ($LASTEXITCODE -ne 0) { throw '专用 WSL 环境导入失败。请确认启用了 CPU 虚拟化并完成 Windows 重启。' }
        }
        $linuxSetup = LinuxPath (Join-Path $PSScriptRoot 'prepare.sh')
        Call-Wsl -Arguments @('bash',$linuxSetup,(LinuxPath $taskRoot))
        # Only our dedicated distribution is stopped. Other WSL projects stay up.
        & wsl.exe --terminate $taskDistro
        if ($LASTEXITCODE -ne 0) { throw '专用环境重新启动准备失败。' }
        Write-Host "准备完成。以后双击 02-启动模型.cmd 即可。播放器连接配置：$taskConnection"
        exit 0
    }
    if (!(Has-Wsl) -or !(Has-Distro) -or !(Test-Path -LiteralPath $taskConfig)) { throw '请先运行 01-首次准备.cmd，完成后再启动。' }
    if ($Action -eq 'Stop') {
        & wsl.exe --terminate $taskDistro
        if ($LASTEXITCODE -ne 0) { throw '停止失败，请确认专用环境名称。' }
        Write-Host '模型专用环境已停止，推理进程和显存已释放；其他 WSL 环境不受影响。'
        exit 0
    }
    $value = Read-Json $taskConfig
    $headers = @{ Authorization='Bearer ' + $value.api_key }
    $health = "http://127.0.0.1:$($value.port)/v1/health"
    if ($Action -eq 'Start') {
        $existing = $null
        try {
            $existing = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 3
        } catch { }
        if ($existing.service -eq 'xianqiji-forced-aligner' -and $existing.ready -and $existing.model -eq $value.model_name) { Write-Host '模型已经运行，不会重复加载。'; exit 0 }
        $socket = New-Object Net.Sockets.TcpClient
        try {
            $connect = $socket.BeginConnect('127.0.0.1', [int]$value.port, $null, $null)
            $occupied = $connect.AsyncWaitHandle.WaitOne(300) -and $socket.Connected
        } catch { $occupied = $false } finally { $socket.Dispose() }
        if ($occupied) { throw '服务端口已占用或旧配置仍在运行。请先停止旧服务，或修改 runtime/service.json 中的端口。' }
        $availableMB = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024
        if ($availableMB -lt 12288) { throw 'Windows 可用内存不足 12GB，请先关闭占用较多的软件，再启动模型。' }
        $gpu = & nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits
        if ($LASTEXITCODE -ne 0) { throw '无法读取 NVIDIA 显存，请检查显卡驱动。' }
        $parts = ($gpu | Select-Object -First 1) -split ','
        if ($parts.Length -ne 2 -or [double]$parts[1] -lt ([double]$parts[0] * $value.gpu_memory_utilization + $value.min_free_gpu_mb)) { throw '当前空闲显存不足以加载模型并保留余量，请先关闭其他 GPU 软件。' }
        Write-Host '正在启动模型。首次启动会编译内核，日志保存在 runtime/logs/server.log。'
        Call-Wsl -Arguments @('bash',(LinuxPath (Join-Path $PSScriptRoot 'start.sh')),(LinuxPath $taskRoot))
        for ($attempt=0; $attempt -lt 90; $attempt++) {
            try {
                $result = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 3
                if ($result.service -eq 'xianqiji-forced-aligner' -and $result.ready) {
                    Write-Host "模型已就绪：$($result.model)"
                    Write-Host "地址：http://127.0.0.1:$($value.port)/v1"
                    Write-Host "请在播放器导入：$taskConnection"
                    if (!$result.resource_ready) { Write-Host "当前等待资源：$($result.reason)" }
                    exit 0
                }
            } catch { }
            Start-Sleep -Seconds 3
        }
        throw '启动等待超时。查看 runtime/logs/server.log；不会继续启动第二份模型。'
    }
    $result = Invoke-RestMethod -Uri $health -Headers $headers -TimeoutSec 5
    Write-Host "模型：$($result.model)；就绪：$($result.ready)；可接任务：$($result.resource_ready)；活动歌曲：$($result.active)"
    if ($result.reason) { Write-Host $result.reason }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
