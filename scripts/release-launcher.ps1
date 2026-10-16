param([ValidateSet('publish', 'prepare', 'resume', 'check')][string]$Mode = 'publish')
$ErrorActionPreference = 'Stop'
try {
    $workspace = Split-Path -Parent $PSScriptRoot
    Set-Location -LiteralPath $workspace
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    $majorVersion = if ($node) { [int]((& $node --version).TrimStart('v').Split('.')[0]) } else { 0 }
    if ($majorVersion -lt 22) {
        if (Test-Path -LiteralPath $bundled) { $node = $bundled }
        else { throw '请先安装 Node.js 22.12 或更高版本。' }
    }
    $option = @{ publish = '--publish'; prepare = '--prepare'; resume = '--resume'; check = '--check' }[$Mode]
    & $node (Join-Path $PSScriptRoot 'release-one-click.cjs') $option '--interactive'
    if ($LASTEXITCODE -ne 0) { throw '流程停止。请查看上方错误；不会自动提交源码、清理文件或重建密钥。' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
