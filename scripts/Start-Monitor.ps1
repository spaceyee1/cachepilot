param([int]$SelectedPid=0,[ValidateSet('user','portable')][string]$Storage='user',[ValidatePattern('^[a-z0-9][a-z0-9_-]{0,63}$')][string]$Profile='default')
$ErrorActionPreference='Stop'
$candidateRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target=Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe'
if(-not(Test-Path -LiteralPath $target)){throw 'Run build-monitor.ps1 first'}
$env:CACHEPILOT_GPU='off';$env:CUDA_VISIBLE_DEVICES='-1';$env:NVIDIA_VISIBLE_DEVICES='none'
$arguments=@('--storage='+$Storage,'--profile='+$Profile)
if($SelectedPid -gt 0){$arguments+=('--pid='+$SelectedPid)}
Start-Process -FilePath $target -ArgumentList $arguments -WorkingDirectory (Join-Path $candidateRoot 'ui') -PassThru | Select-Object Id,ProcessName
