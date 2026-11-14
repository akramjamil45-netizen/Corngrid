$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'mt5-currency-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Currency deployment failed; inspect the deployment result.'}
 Get-Content -LiteralPath $out;exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web')).TrimEnd('\')
$target='C:\Website\Website\Corngrid-web'
$files=@('mt5-currency.js','reports\report-service.js','mt5-api.js','docs\MT5_CURRENCY.md')
$previous=@{'mt5-api.js'='570F1086B086FDC2CFC3D456C1FC3E0D4E5D8A806F17865A3CF24F51F067B034';'reports\report-service.js'='04942276452F65D98CD932CA893B256CD659EA431123A6A3D280491F5686766D'}
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('mt5-currency-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$r=[ordered]@{phase='starting';backup=$backup;files=$files;changed=@();websiteRestarted=$false;databaseMigrationRequired=$false}
$existed=@{};$restartAttempted=$false
function Wait-Ready {
 foreach($attempt in 1..20){try{if((Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3).status -eq 'ok'){return}}catch{};Start-Sleep -Seconds 1}
 throw 'Backend readiness timed out.'
}
try{
 foreach($f in $files){
  $from=[IO.Path]::GetFullPath((Join-Path $source $f));$to=[IO.Path]::GetFullPath((Join-Path $target $f))
  if(-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  if(-not(Test-Path -LiteralPath $from -PathType Leaf)){throw 'Missing source file.'}
  $existed[$f]=Test-Path -LiteralPath $to -PathType Leaf
  if($existed[$f]){
   $hash=(Get-FileHash -LiteralPath $to).Hash
   if($hash -ne (Get-FileHash -LiteralPath $from).Hash -and (-not $previous.ContainsKey($f) -or $hash -ne $previous[$f])){throw ('Unreviewed production change: '+$f)}
  }elseif($previous.ContainsKey($f)){throw ('Missing expected production file: '+$f)}
 }
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 foreach($f in $files){if($existed[$f]){$saved=Join-Path $backup $f;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $target $f) -Destination $saved}}
 foreach($f in $files){
  $r.changed+=$f;Copy-Item -LiteralPath (Join-Path $source $f) -Destination (Join-Path $target $f) -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $f)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $f)).Hash){throw 'Deployed file hash mismatch.'}
 }
 foreach($f in $files|Where-Object{$_ -like '*.js'}){& node.exe --check (Join-Path $target $f);if($LASTEXITCODE -ne 0){throw 'Deployed JavaScript syntax check failed.'}}
 $r.phase='restarting-backend';[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Compress))
 $restartAttempted=$true;Restart-Service -Name CornGridWeb -ErrorAction Stop;$r.websiteRestarted=$true
 Wait-Ready
 $ErrorActionPreference='Continue';$verification=& node.exe (Join-Path $PSScriptRoot 'verify-mt5-currency-live.cjs') 2>&1;$verifyExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($verifyExit -ne 0){throw ('Live verification failed: '+($verification -join ' '))}
 $r.verification=($verification -join '')|ConvertFrom-Json
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $r.terminalPidsPreserved=$before;$r.phase='complete'
}catch{
 $r.phase='failed';$r.error=$_.Exception.Message;$r.rollbackErrors=@()
 foreach($f in $r.changed){try{
  $to=[IO.Path]::GetFullPath((Join-Path $target $f))
  if(-not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe rollback path.'}
  if($existed[$f]){Copy-Item -LiteralPath (Join-Path $backup $f) -Destination $to -Force}else{Remove-Item -LiteralPath $to -Force}
 }catch{$r.rollbackErrors+=$f}}
 if($restartAttempted){try{Restart-Service -Name CornGridWeb;Wait-Ready;$r.rollbackReady=$true}catch{$r.rollbackReady=$false}}
 [IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 6 -Compress));throw
}
$r.completedAt=[DateTime]::UtcNow.ToString('o');[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 6 -Compress))
