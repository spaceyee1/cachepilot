param()
$ErrorActionPreference='Stop'
$candidateRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$references=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xaml.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll')|ForEach-Object {'/reference:'+(Join-Path $framework $_)}
$sources=Get-ChildItem -LiteralPath (Join-Path $candidateRoot 'ui') -Filter '*.cs' | Where-Object {$_.Name -like 'Monitor*.cs' -or $_.Name -in 'ApiBridge.cs','ApiMonitor.cs'} | Sort-Object Name | Select-Object -ExpandProperty FullName
$target=Join-Path $candidateRoot 'ui/CachePilot.Monitor.exe'
$trustedXaml=Join-Path $candidateRoot 'ui/Monitor.xaml'
if((Get-Item -LiteralPath $trustedXaml).Length -gt 65536){throw 'Trusted monitor XAML exceeds build limit'}
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:x64 /optimize+ /utf8output /main:CachePilotMonitor.MonitorApp @references ('/resource:'+$trustedXaml+',CachePilotMonitor.TrustedMonitorXaml') ('/out:'+$target) @sources
if($LASTEXITCODE -ne 0){throw 'Candidate monitor compilation failed'}
Get-FileHash -LiteralPath $target -Algorithm SHA256 | Select-Object Path,Hash
