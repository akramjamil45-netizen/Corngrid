$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'agreement-text-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Agreement TXT deployment failed; inspect the deployment report.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web'
$target='C:\Website\Website\Corngrid-web'
$files=@('partner\agreement-text.js','partner\partner-agreements.js','public\admin.js','public\admin.css','docs\PARTNER_AGREEMENTS.md')
$previous=@{
 'partner\partner-agreements.js'='C78E8B5CCA56974970AF9BC7D9AF0D33E12D0E674D5A2C84819536FF47F2CB3B'
 'public\admin.js'='D21FB41A5BCF59EC4EECA138B950720B39DE31CF028061C089141814861A0394'
 'public\admin.css'='AE00F4B03A9617FA2DBCC4EAB28B5482236C76276BB3C379308568F72EE56467'
 'docs\PARTNER_AGREEMENTS.md'='661C43BE4E29423FF737E421E01626FE87BFCE2BC3A3D38BF745845DA774D172'
}
$versions=@{'admin.css?v=20261113-announcement-image1'='admin.css?v=20261115-agreement-text1';'admin.js?v=20261113-sandbox-refresh2'='admin.js?v=20261115-agreement-text1'}
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('agreement-text-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='starting';backup=$backup;changed=@();serverRestarted=$false;databaseMigrationRequired=$false}
$existed=@{};$restartAttempted=$false
function Wait-Ready{
 foreach($attempt in 1..20){try{if((Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3).status -eq 'ok'){return}}catch{};Start-Sleep -Seconds 1}
 throw 'Backend readiness timed out.'
}
try{
 foreach($f in $files){
  $from=Join-Path $source $f;$to=Join-Path $target $f
  if(-not(Test-Path -LiteralPath $from -PathType Leaf)){throw ('Missing source file: '+$f)}
  $existed[$f]=Test-Path -LiteralPath $to -PathType Leaf
  if($existed[$f]){
   $hash=(Get-FileHash -LiteralPath $to).Hash
   if($hash -ne (Get-FileHash -LiteralPath $from).Hash -and (-not $previous.ContainsKey($f) -or $hash -ne $previous[$f])){throw ('Unreviewed production change: '+$f)}
  }elseif($previous.ContainsKey($f)){throw ('Missing expected production file: '+$f)}
 }
 $htmlPath=Join-Path $target 'public\admin.html';$html=[IO.File]::ReadAllText($htmlPath)
 foreach($old in $versions.Keys){if(-not $html.Contains($old) -and -not $html.Contains($versions[$old])){throw 'Unreviewed admin asset references.'}}
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 foreach($f in $files+@('public\admin.html')){
  $existed[$f]=Test-Path -LiteralPath (Join-Path $target $f)
  if($existed[$f]){$saved=Join-Path $backup $f;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $target $f) -Destination $saved}
 }
 foreach($f in $files){
  $result.changed+=$f
  Copy-Item -LiteralPath (Join-Path $source $f) -Destination (Join-Path $target $f) -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $f)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $f)).Hash){throw 'Deployed file hash mismatch.'}
  if($f.EndsWith('.js')){& node.exe --check (Join-Path $target $f);if($LASTEXITCODE -ne 0){throw 'JavaScript syntax check failed.'}}
 }
 foreach($old in $versions.Keys){$html=$html.Replace($old,$versions[$old])}
 $result.changed+='public\admin.html'
 [IO.File]::WriteAllText($htmlPath,$html,(New-Object Text.UTF8Encoding($false)))
 $result.phase='restarting-backend';[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Compress))
 $restartAttempted=$true;Restart-Service -Name CornGridWeb -ErrorAction Stop;$result.serverRestarted=$true
 Wait-Ready
 $verification=& node.exe (Join-Path $PSScriptRoot 'verify-agreement-text.cjs')
 if($LASTEXITCODE -ne 0){throw 'Live agreement TXT verification failed.'}
 $result.verification=($verification -join '')|ConvertFrom-Json
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $result.terminalPidsPreserved=$before;$result.phase='complete'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message;$result.rollbackErrors=@()
 foreach($f in $result.changed){try{
  $to=[IO.Path]::GetFullPath((Join-Path $target $f))
  if(-not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe rollback path.'}
  if($existed[$f]){Copy-Item -LiteralPath (Join-Path $backup $f) -Destination $to -Force}else{Remove-Item -LiteralPath $to -Force}
 }catch{$result.rollbackErrors+=$f}}
 if($restartAttempted){try{Restart-Service -Name CornGridWeb;Wait-Ready;$result.rollbackReady=$true}catch{$result.rollbackReady=$false}}
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 6 -Compress))
 throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 6 -Compress))
