$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'marketplace-filters-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Marketplace filters deployment failed.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public'
$target='C:\Website\Website\Corngrid-web\public'
$assets=@{'marketplace.js'='B321CC0778F2108369FA65686F6376339826BB397B824E90B785FD124F58DA62';'marketplace.css'='DE2DCAECA27F36676A07AB54E685CA066974CB0200A4E6F1A8AC8E5D2D15469B'}
$files=@('marketplace.js','marketplace.css','admin.html','dashboard.html')
$versions=@{'marketplace.css?v=20261112-partner-release1'='marketplace.css?v=20261115-compact-filters1';'marketplace.js?v=20261112-partner-release1'='marketplace.js?v=20261115-compact-filters1'}
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('marketplace-filters-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='starting';backup=$backup;changed=@();serverRestarted=$false}
try{
 foreach($f in $assets.Keys){
  $hash=(Get-FileHash -LiteralPath (Join-Path $target $f)).Hash
  if($hash -ne $assets[$f] -and $hash -ne (Get-FileHash -LiteralPath (Join-Path $source $f)).Hash){throw ('Unreviewed production change: '+$f)}
 }
 foreach($f in @('admin.html','dashboard.html')){
  $html=[IO.File]::ReadAllText((Join-Path $target $f))
  foreach($old in $versions.Keys){
   if($f -eq 'admin.html' -and $old.StartsWith('marketplace.js')){continue}
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
