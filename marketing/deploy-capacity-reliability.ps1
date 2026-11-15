param([switch]$FrontendOnly)
$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'capacity-reliability-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"'+$(if($FrontendOnly){' -FrontendOnly'}else{''})) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Website reliability deployment failed. Check the result file.'};exit
}
$result=[ordered]@{phase='starting';at=[DateTime]::UtcNow.ToString('o')}
function Report {$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $out -Encoding UTF8}
try{
 if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
 $source=Split-Path -Parent $PSScriptRoot;$target='C:\Website\Website'
 $backup=Join-Path $env:ProgramData ('CornGrid\WebsiteBackups\capacity-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 $files=@('Corngrid-web\public\admin-sandbox.js','Corngrid-web\public\admin.js','Corngrid-web\public\admin.html')
 $files+=@('sw.js')
 $files+=@('Corngrid-web\public\pwa.js')
 if(-not $FrontendOnly){$files+=@('Corngrid-web\db-postgres.js','Corngrid-web\sandbox\sandbox-admin-api.js','Corngrid-web\service\watchdog.ps1')}
 $result.backup=$backup;$result.files=$files
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 foreach($relative in $files){
  $from=[IO.Path]::GetFullPath((Join-Path $source $relative));$to=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  $saved=Join-Path $backup $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null
  Copy-Item -LiteralPath $to -Destination $saved
  Copy-Item -LiteralPath $from -Destination $to -Force
  if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw 'Deployed file integrity mismatch.'}
 }
 $result.frontendOnly=[bool]$FrontendOnly
 if(-not $FrontendOnly){$result.phase='restarting-website';Report;Restart-Service -Name CornGridWeb}
 $ready=$false;foreach($attempt in 1..20){try{$health=Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3;if($health.status -eq 'ok'){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Website readiness check failed.'}
 $watchdog=Get-ScheduledTask -TaskName CornGridWebsiteWatchdog -ErrorAction SilentlyContinue
 if(-not $watchdog){& (Join-Path $target 'Corngrid-web\service\install-watchdog.ps1')|Out-Null}else{Start-ScheduledTask -TaskName CornGridWebsiteWatchdog}
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 $missing=@($before|Where-Object {$_ -notin $after})
 if($missing.Count -gt 0){throw 'A pre-existing terminal PID is missing; inspect hosting immediately.'}
 $result.phase='complete';$result.health=$health;$result.terminalPidsPreserved=$before;$result.watchdog=[string](Get-ScheduledTask -TaskName CornGridWebsiteWatchdog).State
}catch{$result.phase='failed';$result.error=$_.Exception.Message;Report;throw}
Report
