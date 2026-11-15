$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'feed-excerpts-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Feed excerpt deployment failed.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public'
$target='C:\Website\Website\Corngrid-web\public'
$assets=@{'feed.js'='61EA8618FD7CF64ADED80E9C60F303E711FC902B343786E4B28C82B59F2E0055';'dashboard.css'='957AC23D058093A3DADD25DCC794DC49AD9E9F3BFC4BD1BD9C42C647D425824A'}
$files=@('feed.js','dashboard.css','admin.html','dashboard.html')
$versions=@{'dashboard.css?v=20261115-navigation1'='dashboard.css?v=20261115-feed-excerpt1';'feed.js?v=20261113-gallery1'='feed.js?v=20261115-feed-excerpt1'}
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('feed-excerpts-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='starting';backup=$backup;changed=@();serverRestarted=$false}
try{
 foreach($f in $assets.Keys){
  $hash=(Get-FileHash -LiteralPath (Join-Path $target $f)).Hash
  if($hash -ne $assets[$f] -and $hash -ne (Get-FileHash -LiteralPath (Join-Path $source $f)).Hash){throw ('Unreviewed production change: '+$f)}
 }
 foreach($f in @('admin.html','dashboard.html')){
  $html=[IO.File]::ReadAllText((Join-Path $target $f))
  foreach($old in $versions.Keys){
   if($f -eq 'admin.html' -and $old.StartsWith('feed.js')){continue}
   if(-not $html.Contains($old) -and -not $html.Contains($versions[$old])){throw ('Unreviewed script/style reference: '+$f)}
  }
 }
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 foreach($f in $files){Copy-Item -LiteralPath (Join-Path $target $f) -Destination (Join-Path $backup $f)}
 foreach($f in $assets.Keys){
  $result.changed+=$f
  Copy-Item -LiteralPath (Join-Path $source $f) -Destination (Join-Path $target $f) -Force
 }
 foreach($f in @('admin.html','dashboard.html')){
  $file=Join-Path $target $f
  $html=[IO.File]::ReadAllText($file)
  foreach($old in $versions.Keys){$html=$html.Replace($old,$versions[$old])}
  $result.changed+=$f
  [IO.File]::WriteAllText($file,$html,(New-Object Text.UTF8Encoding($false)))
 }
 foreach($f in $assets.Keys){
  if((Get-FileHash -LiteralPath (Join-Path $source $f)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $f)).Hash){throw ('Asset hash mismatch: '+$f)}
 }
 $html=(Invoke-WebRequest -Uri 'http://127.0.0.1:3000/dashboard.html' -UseBasicParsing -TimeoutSec 15).Content
 foreach($version in $versions.Values){if(-not $html.Contains($version)){throw 'Served version mismatch.'}}
 $result.phase='complete'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message
 foreach($f in $result.changed){Copy-Item -LiteralPath (Join-Path $backup $f) -Destination (Join-Path $target $f) -Force}
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Compress))
 throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Compress))
