param()
$ErrorActionPreference='Stop'
$candidateRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$framework=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$references=@('System.dll','System.Core.dll','System.Drawing.dll','System.Security.dll','System.Web.Extensions.dll','System.Windows.Forms.dll')|ForEach-Object {'/reference:'+(Join-Path $framework $_)}
& (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 /optimize+ /utf8output /main:ApiLocalHelper ('/out:'+(Join-Path $candidateRoot 'ui/CachePilot.ApiLocalHelper.exe')) @references (Join-Path $candidateRoot 'ui/ApiLocalHelper.cs')
if($LASTEXITCODE -ne 0){throw 'Independent API helper compilation failed'}
