$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'menu-priority-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Menu deployment failed; inspect the deployment report.'}
 Get-Content -LiteralPath $out;exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public')).TrimEnd('\')
$target='C:\Website\Website\Corngrid-web\public'
$previous=@{'dashboard.html'='CC1EDF1CA522EFD6E84C8F3AC29C28BFD664E312F3F0DE4B630CE2E8BBBBBAEB';'admin.html'='583FBB9CFF534D9B81B9A1AFF0A86ED32554BE3ECC17F1467FDB7193F9BB3647';'dashboard.css'='2558F13B62019402FB53AAE53F2540974C6EDA3A1797BAF7AA571AC6F1759FCE'}
$files=@('dashboard.css','dashboard.html','admin.html')
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('menu-priority-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$r=[ordered]@{phase='starting';backup=$backup;files=$files;changed=@();websiteRestarted=$false;databaseModified=$false}
try{
 foreach($f in $files){
  $from=Join-Path $source $f;$to=Join-Path $target $f
  $current=(Get-FileHash -LiteralPath $to).Hash
  if($current -ne $previous[$f] -and $current -ne (Get-FileHash -LiteralPath $from).Hash){throw ('Unreviewed production change: '+$f)}
 }
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 foreach($f in $files){Copy-Item -LiteralPath (Join-Path $target $f) -Destination (Join-Path $backup $f)}
 foreach($f in $files){
  $r.changed+=$f;Copy-Item -LiteralPath (Join-Path $source $f) -Destination (Join-Path $target $f) -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $f)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $f)).Hash){throw 'Deployed file hash mismatch.'}
 }
 $ErrorActionPreference='Continue';$verification=& node.exe (Join-Path $PSScriptRoot 'verify-menu-priority.cjs') 2>&1;$verifyExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($verifyExit -ne 0){throw ('Live verification failed: '+($verification -join ' '))}
 $r.verification=($verification -join '')|ConvertFrom-Json
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $r.terminalPidsPreserved=$before;$r.phase='complete'
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($f in $r.changed){try{
  $to=[IO.Path]::GetFullPath((Join-Path $target $f))
  if([IO.Path]::GetDirectoryName($to) -ne $target){throw 'Unsafe rollback path.'}
  Copy-Item -LiteralPath (Join-Path $backup $f) -Destination $to -Force
 }catch{$r.rollbackErrors+=$f}}
 [IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 5 -Compress));throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o');[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 5 -Compress))
