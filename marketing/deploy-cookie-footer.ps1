$ErrorActionPreference='Stop'
# Deploy: move the Cookie settings button from the end of <footer> into the "Resources & Tools" list.
$reportPath=Join-Path $PSScriptRoot 'cookie-footer-deployment-result.json'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$target='C:\Website\Website'
$files=@('cookie-consent.js','cookie-consent.css','index.html','en\index.html')
$version='20261122-cookie-footer1'
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('cookie-footer-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
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
 }
 $stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
 foreach($route in @('/','/en/')){
  $page=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com'+$route+'?verifyCookie='+$stamp) -TimeoutSec 20
  if($page.StatusCode -ne 200 -or $page.Content -notmatch ('cookie-consent\.js\?v='+[regex]::Escape($version))){throw ('Live page verification failed: '+$route)}
 }
 $css=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com/cookie-consent.css?v='+$version+'&verify='+$stamp) -TimeoutSec 20
 if($css.StatusCode -ne 200 -or -not $css.Content.Contains('.footer-links .cg-cookie-settings')){throw 'Live cookie CSS verification failed.'}
 $js=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com/cookie-consent.js?v='+$version+'&verify='+$stamp) -TimeoutSec 20
 if($js.StatusCode -ne 200 -or -not $js.Content.Contains("footer.querySelectorAll('ul.footer-links')")){throw 'Live cookie JS verification failed.'}
 $r.phase='complete';$r.publicPagesVerified=$true;$r.assetsVerified=$true
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($relative in $r.changed){try{Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force}catch{$r.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
 throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
$r|ConvertTo-Json -Depth 5
