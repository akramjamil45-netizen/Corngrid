$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'loopback-gateway-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Gateway installation failed. Check the sanitized result.'};exit
}
$result=[ordered]@{phase='starting';at=[DateTime]::UtcNow.ToString('o');webRestarted=$false;agentsStopped=$false}
function Report {$result|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $out -Encoding UTF8}
$bindingChanged=$false
function Site-Manager {New-Object Microsoft.Web.Administration.ServerManager}
try{
 if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
 if(Get-Service CornGridGateway -ErrorAction SilentlyContinue){throw 'Gateway already exists. Do not reinstall it.'}
 if(Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue){throw 'Static target port is already in use.'}
 [void][Reflection.Assembly]::LoadFrom('C:\Windows\System32\inetsrv\Microsoft.Web.Administration.dll')
 $manager=Site-Manager
 try{
  $site=$manager.Sites['CorngridMaster']
  if(-not $site -or $site.Bindings.Count -ne 1 -or $site.Bindings[0].BindingInformation -ne '*:8080:' -or $site.Bindings[0].Protocol -ne 'http' -or $site.Applications['/'].VirtualDirectories['/'].PhysicalPath -ne 'C:\Website\Website'){throw 'Unexpected website binding or physical path.'}
 }finally{$manager.Dispose()}
 $root=Split-Path -Parent $PSScriptRoot;$runtime='C:\ProgramData\CornGrid\Gateway'
 if(Test-Path -LiteralPath $runtime){throw 'Gateway runtime already exists. Inspect before reusing.'}
 New-Item -ItemType Directory -Path $runtime|Out-Null
 & icacls.exe $runtime '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect gateway runtime.'}
 Copy-Item -LiteralPath 'C:\Website\Website\Corngrid-web\service\CornGridWeb.exe' -Destination (Join-Path $runtime 'CornGridGateway.exe')
 foreach($file in @('iis-gateway.js','CornGridGateway.xml')){
  $from=Join-Path $root ('Corngrid-web\service\'+$file);$to=Join-Path $runtime $file
  Copy-Item -LiteralPath $from -Destination $to
  if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw 'Gateway file integrity check failed.'}
 }
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 $backup=Join-Path $runtime 'binding-before.json';@{site='CorngridMaster';binding='*:8080:';protocol='http'}|ConvertTo-Json|Set-Content -LiteralPath $backup
 $result.backup=$backup;$result.phase='service-install';Report
 & (Join-Path $runtime 'CornGridGateway.exe') install *> (Join-Path $runtime 'installation.log')
 if($LASTEXITCODE -ne 0){throw 'Gateway service registration failed.'}
 $result.phase='switching-loopback-binding';Report
 $manager=Site-Manager
 try{$site=$manager.Sites['CorngridMaster'];[void]$site.Stop();$site.Bindings[0].BindingInformation='127.0.0.1:18080:';$manager.CommitChanges();$bindingChanged=$true;[void]$site.Start()}finally{$manager.Dispose()}
 $static=Invoke-WebRequest 'http://127.0.0.1:18080/api/health/ready' -UseBasicParsing -TimeoutSec 5
 if($static.StatusCode -ne 200){throw 'IIS static site did not recover on its private binding.'}
 Start-Service CornGridGateway
 $ready=$false;foreach($attempt in 1..20){try{$health=Invoke-RestMethod 'http://127.0.0.1:8080/api/health/ready' -TimeoutSec 2;if($health.status -eq 'ok'){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Gateway API readiness failed.'}
 $public=Invoke-RestMethod 'https://corngrid.com/api/health/ready' -TimeoutSec 8
 if($public.status -ne 'ok'){throw 'Public API readiness failed.'}
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 if(@($before|Where-Object {$_ -notin $after}).Count){throw 'A pre-existing terminal PID is missing.'}
 $result.phase='complete';$result.gatewayService=[string](Get-Service CornGridGateway).Status;$result.health=$health;$result.publicHealthy=$true;$result.terminalPidsPreserved=$before;$result.apiTarget='127.0.0.1:3000';$result.staticTarget='127.0.0.1:18080'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message
 try{
  if(Get-Service CornGridGateway -ErrorAction SilentlyContinue){Set-Service CornGridGateway -StartupType Disabled;Stop-Service CornGridGateway -ErrorAction SilentlyContinue}
  if($bindingChanged){$manager=Site-Manager;try{$site=$manager.Sites['CorngridMaster'];[void]$site.Stop();$site.Bindings[0].BindingInformation='*:8080:';$manager.CommitChanges();[void]$site.Start()}finally{$manager.Dispose()}}
  $result.rolledBack=$true
 }catch{$result.rolledBack=$false}
 Report;throw
}
Report
