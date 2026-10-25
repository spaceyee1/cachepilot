param()
$ErrorActionPreference='Stop'
$candidateRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$run=Join-Path $candidateRoot ('validation/offline-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'))
if(Test-Path -LiteralPath $run){throw 'Fresh validation directory required'}
[IO.Directory]::CreateDirectory($run)|Out-Null
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$references=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xaml.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll')|ForEach-Object {'/reference:'+(Join-Path $framework $_)}
$sources=Get-ChildItem -LiteralPath (Join-Path $candidateRoot 'ui') -File -Filter '*.cs' | Where-Object {$_.Name -like 'Monitor*.cs' -or $_.Name -in 'ApiBridge.cs','ApiMonitor.cs'} | Sort-Object Name | Select-Object -ExpandProperty FullName
function Start-Offline([string]$file,[string[]]$arguments,[int]$timeoutSeconds){
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=$file;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.Environment.Clear()
 foreach($name in @('SystemRoot','WINDIR','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$start.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
 $start.Environment['PATH']=Join-Path $env:WINDIR 'System32'
 $start.Environment['CUDA_VISIBLE_DEVICES']='-1';$start.Environment['CACHEPILOT_DEVICE']='off'
 foreach($argument in $arguments){$start.ArgumentList.Add($argument)}
 $watch=[Diagnostics.Stopwatch]::StartNew();$started=[DateTimeOffset]::UtcNow.ToString('o')
 $process=$null;$exit=-1;$timedOut=$false;$out='';$err='';$killRequested=$false
 try{
  $process=[Diagnostics.Process]::Start($start)
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(!$process.WaitForExit($timeoutSeconds*1000)){$timedOut=$true;$killRequested=$true;$process.Kill($true);[void]$process.WaitForExit(2000)}
  if($process.HasExited){$exit=$process.ExitCode}
  if($stdout.Wait(2000)){$out=$stdout.GetAwaiter().GetResult()}
  if($stderr.Wait(2000)){$err=$stderr.GetAwaiter().GetResult()}
 }finally{if($process){if(!$process.HasExited){$killRequested=$true;$process.Kill($true);[void]$process.WaitForExit(2000)};$process.Dispose()}}
 [PSCustomObject]@{startedUtc=$started;elapsedMs=$watch.ElapsedMilliseconds;exitCode=$exit;timedOut=$timedOut;timeoutSeconds=$timeoutSeconds;ownedTreeKillRequested=$killRequested;stdout=$out;stderr=$err}
}
$steps=[Collections.Generic.List[object]]::new()
$trusted=Join-Path $candidateRoot 'ui/Monitor.xaml'


$buildArgs=@('/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/main:CachePilotMonitor.MonitorApp',('/out:'+(Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe')),('/resource:'+$trusted+',CachePilotMonitor.TrustedMonitorXaml'))+$references+$sources
$build=Start-Offline (Join-Path $framework 'csc.exe') $buildArgs 60
$steps.Add([PSCustomObject]@{name='product-build';result=$build})
$productHash=$null
if($build.exitCode -eq 0 -and !$build.timedOut){
 $productHash=(Get-FileHash -LiteralPath (Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
 $trusted=Join-Path $candidateRoot 'ui/Monitor.xaml'
 
 foreach($test in @(@{name='gpu-controls';main='GpuControlsAcceptance';source='ui-gpu-controls-acceptance.cs'},@{name='watermark';main='WatermarkAcceptance';source='ui-watermark-acceptance.cs'},@{name='api';main='ApiAcceptance';source='ui-api-acceptance.cs'},@{name='scroll';main='ScrollAcceptance';source='ui-scroll-acceptance.cs'},@{name='release';main='ReleaseAcceptance';source='ui-release-acceptance.cs';candidateArgument=$true})){
  $exe=Join-Path $run ($test.name+'.exe');$report=Join-Path $run ($test.name+'.json')
  $args=@('/nologo','/target:exe','/platform:x64','/optimize+','/utf8output',('/main:'+$test.main),('/out:'+$exe),('/resource:'+$trusted+',CachePilotMonitor.TrustedMonitorXaml'))+$references+$sources+@(Join-Path $candidateRoot ('tests/'+$test.source))
  $compile=Start-Offline (Join-Path $framework 'csc.exe') $args 60
  $execution=$null
  if($compile.exitCode -eq 0 -and !$compile.timedOut){$input=if($test.candidateArgument){$candidateRoot}else{$trusted};$execution=Start-Offline $exe @($input,$report) 60}
  $steps.Add([PSCustomObject]@{name=$test.name;compile=$compile;execution=$execution;report=$report})
 }
}
$after=if($productHash){(Get-FileHash -LiteralPath (Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe') -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
$all=$build.exitCode -eq 0 -and !$build.timedOut -and $productHash -eq $after
foreach($step in $steps){if($step.name -ne 'product-build'){$all=$all -and $step.compile.exitCode -eq 0 -and !$step.compile.timedOut -and $null -ne $step.execution -and $step.execution.exitCode -eq 0 -and !$step.execution.timedOut}}
$summary=[ordered]@{schema=1;candidateRoot=$candidateRoot;run=$run;overall=if($all){'pass'}else{'fail'};productExeSha256BeforeTests=$productHash;productExeSha256AfterTests=$after;productUnchangedDuringTests=if($productHash){$productHash -eq $after}else{$null};gpu='off';gpuExecuted=$false;pythonExecuted=$false;keyUsed=$false;providerApiRequests=0;visibleWindowOpened=$false;hostConfigurationRead=$false;hostConfigurationWritten=$false;symlinkJunctionVerification='skipped by user request';permissionMutationTests='skipped by user request';steps=$steps}
$summaryPath=Join-Path $run 'runner.json'
$stream=[IO.FileStream]::new($summaryPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false));try{$writer.Write(($summary|ConvertTo-Json -Depth 15))}finally{$writer.Dispose()}}finally{$stream.Dispose()}
Write-Output ('summary='+$summaryPath)
foreach($step in $steps){if($step.result){Write-Output $step.result.stdout;Write-Output $step.result.stderr};if($step.compile){Write-Output $step.compile.stdout;Write-Output $step.compile.stderr};if($step.execution){Write-Output $step.execution.stdout;Write-Output $step.execution.stderr}}
if(!$all){throw 'UI8 offline validation failed; fresh reports retained'}
