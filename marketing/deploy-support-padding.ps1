$ErrorActionPreference='Stop'
$reportPath=Join-Path $PSScriptRoot 'support-padding-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Padding deployment failed; inspect the deployment report.'}
 Get-Content -LiteralPath $reportPath
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$target='C:\Website\Website'
$files=@('infrastructure.css','index.html','en\index.html','marketing\build.js')
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('support-padding-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$r=[ordered]@{phase='starting';backup=$backup;files=$files;websiteRestarted=$false;changed=@()}
try{
 foreach($relative in $files){
  $from=[IO.Path]::GetFullPath((Join-Path $source $relative));$to=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  if(-not(Test-Path -LiteralPath $from -PathType Leaf) -or -not(Test-Path -LiteralPath $to -PathType Leaf)){throw ('Missing deployment file: '+$relative)}
 }
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 foreach($relative in $files){
  $saved=Join-Path $backup $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $target $relative) -Destination $saved
 }
 foreach($relative in $files){
  $from=Join-Path $source $relative;$to=Join-Path $target $relative
  $r.changed+=$relative
  Copy-Item -LiteralPath $from -Destination $to -Force
  if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw ('Deployment hash mismatch: '+$relative)}
 }
 $health=Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 10
 if($health.status -ne 'ok'){throw 'Backend readiness failed.'}
 $stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
 foreach($route in @('/','/en/')){
  $page=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com'+$route+'?verifyPadding='+$stamp) -TimeoutSec 20
  if($page.StatusCode -ne 200 -or $page.Content -notmatch 'infrastructure\.css\?v=20261114-support-padding1'){throw ('Live page verification failed: '+$route)}
 }
 $css=Invoke-WebRequest -UseBasicParsing 'https://corngrid.com/infrastructure.css?v=20261114-support-padding1' -TimeoutSec 20
 if($css.StatusCode -ne 200 -or -not $css.Content.Contains('.infra-page #support { padding-block: clamp(32px,5vw,64px); }')){throw 'Live padding CSS verification failed.'}
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $r.phase='complete';$r.backendReady=$true;$r.publicPagesVerified=$true;$r.terminalPidsPreserved=$before
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($relative in $r.changed){try{Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force}catch{$r.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
 throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
