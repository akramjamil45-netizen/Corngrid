$ErrorActionPreference = 'Stop'
$brokerPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $brokerPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
$brokerResult = Join-Path $PSScriptRoot 'broker-connection-result.json'
$brokerRoot = 'C:\CornGrid\Sandbox\Users\sbx_84446930a077903578'
$brokerBackup = Join-Path $brokerRoot ('connection-backup-' + (Get-Date -Format yyyyMMdd-HHmmss))
try {
 if (-not (Test-Path -LiteralPath $brokerRoot)) { throw 'The target sandbox no longer exists.' }
 $brokerConfig = Get-Content 'C:\Website\Website\Corngrid-web\agent\agent-config.json' -Raw | ConvertFrom-Json
 $brokerSource = Join-Path $brokerConfig.brokerServerDataDirs.'LiteFinance-MT5-Demo' 'config\servers.dat'
 if (-not (Test-Path -LiteralPath $brokerSource)) { throw 'Known broker cache is unavailable.' }
 New-Item -ItemType Directory -Path $brokerBackup | Out-Null
 Stop-ScheduledTask -TaskName CornGridSandboxAgent
 Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $brokerRoot 'terminal64.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 foreach ($brokerFile in @('servers.dat','dnsperf.dat')) {
  $brokerPath = Join-Path $brokerRoot ('config\' + $brokerFile)
  if (Test-Path -LiteralPath $brokerPath) { Move-Item -LiteralPath $brokerPath -Destination (Join-Path $brokerBackup $brokerFile) }
 }
 Copy-Item -LiteralPath $brokerSource -Destination (Join-Path $brokerRoot 'config\servers.dat')
 Start-ScheduledTask -TaskName CornGridSandboxAgent
 @{success=$true;backup=$brokerBackup;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $brokerResult
} catch {
 Start-ScheduledTask -TaskName CornGridSandboxAgent -ErrorAction SilentlyContinue
 @{success=$false;error=$_.Exception.Message;backup=$brokerBackup} | ConvertTo-Json | Set-Content -LiteralPath $brokerResult
 throw
}
