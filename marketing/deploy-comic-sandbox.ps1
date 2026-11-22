$ErrorActionPreference='Stop'
# Deploy: comic-book "Gold Blast" treatment for the public Sandbox preview panel.
$reportPath=Join-Path $PSScriptRoot 'comic-sandbox-deployment-result.json'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$target='C:\Website\Website'
$files=@('infrastructure.css','index.html','en\index.html','marketing\build.js')
$version='20261122-comic-sandbox1'
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('comic-sandbox-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
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
  $page=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com'+$route+'?verifyComic='+$stamp) -TimeoutSec 20
  if($page.StatusCode -ne 200){throw ('Live page failed: '+$route)}
  foreach($needle in @(('infrastructure.css?v='+$version),'family=Bangers','cg-comic-burst')){
   if(-not $page.Content.Contains($needle)){throw ('Live page missing '+$needle+': '+$route)}
  }
 }
 $css=Invoke-WebRequest -UseBasicParsing -Uri ('https://corngrid.com/infrastructure.css?v='+$version+'&verify='+$stamp) -TimeoutSec 20
 if($css.StatusCode -ne 200 -or -not $css.Content.Contains('.sandbox-preview .cg-comic-burst')){throw 'Live comic CSS verification failed.'}
 $r.phase='complete';$r.publicPagesVerified=$true;$r.cssVerified=$true
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($relative in $r.changed){try{Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $target $relative) -Force}catch{$r.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
 throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($reportPath,($r|ConvertTo-Json -Depth 5 -Compress))
$r|ConvertTo-Json -Depth 5
