$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$report=Join-Path $PSScriptRoot 'notification-english-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Notification language deployment failed; inspect the deployment report.'}
 Get-Content -LiteralPath $report;exit
}
$source=Split-Path -Parent $PSScriptRoot;$target='C:\Website\Website'
$files=@('Corngrid-web/public/notifications.js','Corngrid-web/public/dashboard.html','Corngrid-web/docs/NOTIFICATION_CENTER.md','sw.js')
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('notification-english-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='preparing';backup=$backup;changed=@();serverRestarted=$false;databaseModified=$false}
$before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
try{
 $raw=& node.exe (Join-Path $PSScriptRoot 'deploy-notification-center.cjs') inspect
 if($LASTEXITCODE -ne 0){throw 'Production baseline inspection failed.'}
 $inspection=($raw -join '')|ConvertFrom-Json
 foreach($relative in $files){
  $to=[IO.Path]::GetFullPath((Join-Path $target $relative));$from=[IO.Path]::GetFullPath((Join-Path $source $relative))
  if(-not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  $entry=@($inspection.runtime|Where-Object{$_.name -eq $relative})
  if($entry.Count -ne 1 -or -not $entry[0].exists -or $entry[0].productionDiverged){throw ('Unreviewed production difference: '+$relative)}
 }
 $null=New-Item -ItemType Directory -Path $backup
 & icacls.exe $backup /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect deployment backup.'}
 foreach($relative in $files){$saved=Join-Path $backup $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $target $relative) -Destination $saved}
 foreach($relative in $files){
  $result.changed+=$relative;Copy-Item -LiteralPath (Join-Path $source $relative) -Destination (Join-Path $target $relative) -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative)).Hash){throw 'Deployed asset hash mismatch.'}
 }
 $verification=& node.exe (Join-Path $PSScriptRoot 'deploy-notification-center.cjs') public
 if($LASTEXITCODE -ne 0){throw 'Public asset verification failed.'}
 $result.verification=($verification -join '')|ConvertFrom-Json
 $result.health=Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 5
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'An existing MT5 process is missing.'}
 $result.terminalPidsPreserved=$before;$result.phase='complete'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message;$result.rollbackErrors=@()
 foreach($relative in $result.changed){try{Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force}catch{$result.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 7));throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 7))
