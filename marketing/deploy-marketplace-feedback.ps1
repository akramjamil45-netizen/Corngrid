$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'marketplace-feedback-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Marketplace feedback deployment failed.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public\marketplace-ui.js'
$target='C:\Website\Website\Corngrid-web\public'
$files=@('marketplace-ui.js','admin.html','dashboard.html')
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('marketplace-feedback-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$old='marketplace-ui.js?v=20261112-partner-release1'
$new='marketplace-ui.js?v=20261115-publication-feedback1'
$result=[ordered]@{phase='starting';backup=$backup;files=$files;changed=@();serverRestarted=$false}
try{
 $current=(Get-FileHash -LiteralPath (Join-Path $target 'marketplace-ui.js')).Hash
 if($current -ne '5A603BC063621D54965BF8E44911FA644AEFE8A4A81439C17FD922B0FAAEF6E5' -and $current -ne (Get-FileHash -LiteralPath $source).Hash){throw 'Unreviewed Marketplace script change.'}
 foreach($f in @('admin.html','dashboard.html')){
  $html=[IO.File]::ReadAllText((Join-Path $target $f))
  if(-not $html.Contains($old) -and -not $html.Contains($new)){throw ('Unreviewed script reference: '+$f)}
 }
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 foreach($f in $files){Copy-Item -LiteralPath (Join-Path $target $f) -Destination (Join-Path $backup $f)}
 $result.changed+='marketplace-ui.js'
 Copy-Item -LiteralPath $source -Destination (Join-Path $target 'marketplace-ui.js') -Force
 foreach($f in @('admin.html','dashboard.html')){
  $file=Join-Path $target $f
  $html=[IO.File]::ReadAllText($file)
  if($html.Contains($old)){
   $result.changed+=$f
   [IO.File]::WriteAllText($file,$html.Replace($old,$new),(New-Object Text.UTF8Encoding($false)))
  }
 }
 if((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target 'marketplace-ui.js')).Hash){throw 'Script hash mismatch.'}
 foreach($f in @('admin.html','dashboard.html')){
  $html=(Invoke-WebRequest -Uri ('http://127.0.0.1:3000/'+$f) -UseBasicParsing -TimeoutSec 15).Content
  if(-not $html.Contains($new)){throw 'Served cache version mismatch.'}
 }
 $result.phase='complete'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message
 foreach($f in $result.changed){Copy-Item -LiteralPath (Join-Path $backup $f) -Destination (Join-Path $target $f) -Force}
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Compress))
 throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Compress))
