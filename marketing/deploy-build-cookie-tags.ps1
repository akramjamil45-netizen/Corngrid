$ErrorActionPreference='Stop'
# Deploy: marketing/build.js was missing the cookie-consent tags, so regenerating the
# public pages would drop the consent banner. It is also served publicly at
# /marketing/build.js, so verify the live copy after the copy.
$reportPath=Join-Path $PSScriptRoot 'build-cookie-deployment-result.json'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$target='C:\Website\Website'
$files=@('marketing\build.js')
$needle='/cookie-consent.css?v=20261122-cookie-footer1'
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('build-cookie-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$r=[ordered]@{phase='starting';backup=$backup;files=$files;changed=@()}
try{
 foreach($relative in $files){
  $from=[IO.Path]::GetFullPath((Join-Path $source $relative));$to=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  if(-not(Test-Path -LiteralPath $from -PathType Leaf) -or -not(Test-Path -LiteralPath $to -PathType Leaf)){throw ('Missing deployment file: '+$relative)}
 }
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
  if(-not (Get-Content -LiteralPath $to -Raw).Contains($needle)){throw ('Deployed file is missing the cookie tag: '+$relative)}
 }
 $stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
 $live=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com/marketing/build.js?verify='+$stamp) -TimeoutSec 20
 if($live.StatusCode -ne 200 -or -not $live.Content.Contains($needle)){throw 'Live build.js verification failed.'}
 $r.phase='complete';$r.liveVerified=$true
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($relative in $r.changed){try{Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force}catch{$r.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
 throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
$r|ConvertTo-Json -Depth 5
