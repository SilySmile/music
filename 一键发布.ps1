param([ValidateSet('publish', 'prepare', 'resume', 'check')][string]$Mode = 'publish')
& (Join-Path $PSScriptRoot 'scripts\release-launcher.ps1') -Mode $Mode
exit $LASTEXITCODE
