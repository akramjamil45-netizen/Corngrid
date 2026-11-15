param([switch]$Activate)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"'+$(if($Activate){' -Activate'})
 $child=Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 Get-Content (Join-Path $PSScriptRoot 'broker-resolution-result.json') -ErrorAction SilentlyContinue
 if($child.ExitCode -ne 0){throw 'Broker resolution deployment failed'}
 exit
}
$workspace=Split-Path $PSScriptRoot -Parent
$source=Join-Path $workspace 'Corngrid-web'
$target='C:\Website\Website\Corngrid-web'
$python='C:\Users\mohamad akram\AppData\Local\Programs\Python\Python313\python.exe'
$result=Join-Path $PSScriptRoot 'broker-resolution-result.json'
$backup=Join-Path $env:TEMP ('CornGrid-broker-resolution-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
try{
 $modules=Join-Path $target 'agent\broker-python'
 New-Item -ItemType Directory -Path $modules -Force | Out-Null
 foreach($name in @('MetaTrader5','metatrader5-5.0.6231.dist-info','numpy','numpy-2.5.4.dist-info','numpy.libs')){
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('broker-python\'+$name)) -Destination $modules -Recurse -Force
 }
 $previousPythonPath=$env:PYTHONPATH
 try{$env:PYTHONPATH=$modules;& $python (Join-Path $source 'agent\broker-probe.py') --check;if($LASTEXITCODE -ne 0){throw 'Python tools are unavailable'}}finally{$env:PYTHONPATH=$previousPythonPath}
 $files=@('agent\broker-resolution.js','agent\broker-probe.py','agent\resolve-broker.ps1','agent\setup-broker-tools.ps1','agent\broker-server-cache.js','agent\mt5-startup.js','agent\mt5-manager.js','agent\config.js','agent\agent-config.example.json','docs\WINDOWS_AGENT_SETUP.md','test\broker-resolution.test.js','test\broker_probe_test.py','test\broker-server-cache.test.js','test\mt5-startup.test.js','test\agent-recovery.test.js','public\mt5-brokers.json')
 foreach($relative in $files){
  $dest=Join-Path $target $relative
  $saved=Join-Path $backup $relative
  New-Item -ItemType Directory -Path (Split-Path $saved -Parent) -Force | Out-Null
  if(Test-Path -LiteralPath $dest){Copy-Item -LiteralPath $dest -Destination $saved -Force}
  Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $dest -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash -ne (Get-FileHash -LiteralPath $dest).Hash){throw ('Hash mismatch: '+$relative)}
 }
 $cfgPath=Join-Path $target 'agent\agent-config.json'
 Copy-Item -LiteralPath $cfgPath -Destination (Join-Path $backup 'agent-config.json')
 & node (Join-Path $PSScriptRoot 'configure-broker-tools.cjs')
 if($LASTEXITCODE -ne 0){throw 'Broker tool configuration failed'}
 & node (Join-Path $PSScriptRoot 'verify-broker-resolution.cjs')
 if($LASTEXITCODE -ne 0){throw 'Isolated broker/symbol verification failed; agent was not restarted'}
 if($Activate){
  $before=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -like 'C:\CornGrid\Sandbox\Users\*\terminal64.exe' } | Select-Object -ExpandProperty ProcessId)
  $agents=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' })
  foreach($agent in $agents){Stop-Process -Id $agent.ProcessId -Force}
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName CornGridSandboxAgent
  Start-Sleep -Seconds 10
  $after=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -like 'C:\CornGrid\Sandbox\Users\*\terminal64.exe' } | Select-Object -ExpandProperty ProcessId)
  $preserved=@($before | Where-Object { $_ -in $after }).Count -eq $before.Count
  @{success=$true;files=$files.Count;backup=$backup;activated=$true;terminalPidsPreserved=$preserved;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $result
 }else{@{success=$true;files=$files.Count;backup=$backup;activated=$false;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $result}
}catch{
 @{success=$false;backup=$backup;error=$_.Exception.Message;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $result
 throw
}
