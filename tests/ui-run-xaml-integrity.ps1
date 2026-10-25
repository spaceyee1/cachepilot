param()
$ErrorActionPreference='Stop'
$candidateRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$run=Join-Path $candidateRoot ('validation/xaml-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'))
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

$exe=Join-Path $run 'xaml.exe';$report=Join-Path $run 'result.json'
$resource=Join-Path $candidateRoot 'ui/Monitor.xaml'
$before=(Get-FileHash -LiteralPath (Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$args=@('/nologo','/target:exe','/platform:x64','/optimize+','/utf8output','/main:XamlIntegrityAcceptance',('/out:'+$exe),('/resource:'+$resource+',CachePilotMonitor.TrustedMonitorXaml'))+$references+$sources+@(Join-Path $candidateRoot 'tests/ui-xaml-integrity.cs')
$compile=Start-Offline (Join-Path $framework 'csc.exe') $args 60
$execution=$null
if($compile.exitCode -eq 0 -and !$compile.timedOut){$execution=Start-Offline $exe @($candidateRoot,$run,$report) 60}
$after=(Get-FileHash -LiteralPath (Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$all=$compile.exitCode -eq 0 -and !$compile.timedOut -and $null -ne $execution -and $execution.exitCode -eq 0 -and !$execution.timedOut -and $before -eq $after
$summary=[ordered]@{schema=1;scope='UI8 source compile, no product rebuild; positive offscreen and invalid-input component checks';candidateRoot=$candidateRoot;run=$run;overall=if($all){'pass'}else{'fail'};productExeSha256Before=$before;productExeSha256After=$after;productUnchanged=$before -eq $after;gpu='off';keyUsed=$false;providerApiRequests=0;visibleWindowOpened=$false;compile=$compile;execution=$execution;report=$report}
$summaryPath=Join-Path $run 'runner.json'
$stream=[IO.FileStream]::new($summaryPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false));try{$writer.Write(($summary|ConvertTo-Json -Depth 15))}finally{$writer.Dispose()}}finally{$stream.Dispose()}
Write-Output ('summary='+$summaryPath)
Write-Output $compile.stdout;Write-Output $compile.stderr
if($execution){Write-Output $execution.stdout;Write-Output $execution.stderr}
if(!$all){throw 'UI8 XAML validation failed; fresh reports retained'}
