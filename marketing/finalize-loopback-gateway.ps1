$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Gateway finalization failed.'};exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong host.'}
$root=Split-Path -Parent $PSScriptRoot
$before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
Copy-Item -LiteralPath (Join-Path $root 'Corngrid-web\service\CornGridGateway.xml') -Destination 'C:\ProgramData\CornGrid\Gateway\CornGridGateway.xml' -Force
# Gateway remains alive when the application backend is restarted for a deploy.
& sc.exe config CornGridGateway 'depend=' 'Tcpip' *> $null
if($LASTEXITCODE -ne 0){throw 'Unable to update gateway service dependencies.'}
$gatewaySource=Join-Path $root 'Corngrid-web\service\iis-gateway.js'
$gatewayRuntime='C:\ProgramData\CornGrid\Gateway\iis-gateway.js'
$gatewayRestarted=$false
if((Get-FileHash -LiteralPath $gatewaySource).Hash -ne (Get-FileHash -LiteralPath $gatewayRuntime).Hash){
 Copy-Item -LiteralPath $gatewayRuntime -Destination ($gatewayRuntime+'.before-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
 Copy-Item -LiteralPath $gatewaySource -Destination $gatewayRuntime -Force
 Restart-Service CornGridGateway;$gatewayRestarted=$true
}
Copy-Item -LiteralPath (Join-Path $root 'Corngrid-web\service\watchdog.ps1') -Destination 'C:\Website\Website\Corngrid-web\service\watchdog.ps1' -Force
Start-ScheduledTask -TaskName CornGridWebsiteWatchdog
$after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
if(@($before|Where-Object {$_ -notin $after}).Count){throw 'A pre-existing terminal PID is missing.'}
@{at=[DateTime]::UtcNow.ToString('o');gateway=[string](Get-Service CornGridGateway).Status;backendDependents=@((Get-Service CornGridWeb).DependentServices|Select-Object -ExpandProperty Name);gatewayRestarted=$gatewayRestarted;terminalPidsPreserved=$before}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'gateway-finalization-result.json') -Encoding UTF8
