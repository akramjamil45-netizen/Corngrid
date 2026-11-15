$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 Get-Content (Join-Path $PSScriptRoot 'broker-resolution-result.json')
 if($child.ExitCode -ne 0){throw 'Agent activation failed'}
 exit
}
$resultPath=Join-Path $PSScriptRoot 'broker-resolution-result.json'
$result=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if(-not $result.success){throw 'No successful isolated broker verification is recorded'}
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'Corngrid-web'
$target='C:\Website\Website\Corngrid-web'
foreach($relative in @('agent\agent.js','agent\package.json','agent\package-lock.json','test\client-api-paths.test.js','test\broker-deploy.test.js')){
 $dest=Join-Path $target $relative
 $saved=Join-Path $result.backup $relative
 New-Item -ItemType Directory -Path (Split-Path $saved -Parent) -Force | Out-Null
 if((Test-Path -LiteralPath $dest) -and -not (Test-Path -LiteralPath $saved)){Copy-Item -LiteralPath $dest -Destination $saved}
 Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $dest -Force
}
foreach($relative in @('agent\agent.js','agent\config.js','agent\mt5-manager.js','agent\mt5-startup.js','agent\broker-server-cache.js','agent\broker-resolution.js','agent\resolve-broker.ps1','agent\broker-probe.py')){
 if((Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative)).Hash){throw ('Runtime hash mismatch: '+$relative)}
}
$before=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -like 'C:\CornGrid\Sandbox\Users\*\terminal64.exe' } | Select-Object -ExpandProperty ProcessId)
$agents=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' })
foreach($agent in $agents){Stop-Process -Id $agent.ProcessId -Force}
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName CornGridSandboxAgent
Start-Sleep -Seconds 12
$after=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -like 'C:\CornGrid\Sandbox\Users\*\terminal64.exe' } | Select-Object -ExpandProperty ProcessId)
$active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' })
if(-not $active.Count){throw 'Agent did not restart'}
$result | Add-Member NoteProperty activated $true -Force
$result | Add-Member NoteProperty agentVersion '1.1.0' -Force
$result | Add-Member NoteProperty terminalPidsPreserved (@($before | Where-Object { $_ -in $after }).Count -eq $before.Count) -Force
$result | Add-Member NoteProperty time ((Get-Date).ToString('o')) -Force
$result | ConvertTo-Json | Set-Content -LiteralPath $resultPath
