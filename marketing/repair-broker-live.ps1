param([switch]$Inspect)
$ErrorActionPreference='Stop'
$liveResult=Join-Path $PSScriptRoot 'broker-live-result.json'
trap { Start-ScheduledTask CornGridSandboxAgent -ErrorAction SilentlyContinue; @{success=$false;error=($_ | Out-String)} | ConvertTo-Json | Set-Content -LiteralPath $liveResult; exit 1 }
$livePrincipal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $livePrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"' + $(if ($Inspect) {' -Inspect'})) -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
if ($Inspect) {
 @{
  processes=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Select-Object ProcessId,SessionId,ExecutablePath,CommandLine)
  firewall=@(Get-NetFirewallRule -Enabled True -Direction Outbound -Action Block | ForEach-Object { $rule=$_; $_ | Get-NetFirewallApplicationFilter | Select-Object Program,@{n='Rule';e={$rule.DisplayName}} })
  tcp=@(Get-NetTCPConnection | Where-Object OwningProcess -in (Get-Process terminal64).Id | Select-Object OwningProcess,RemoteAddress,RemotePort,State)
  profiles=@(Get-NetFirewallProfile | Select-Object Name,DefaultOutboundAction)
  firewallIdentity=@(Get-NetFirewallRule -Enabled True -Direction Outbound -Action Block | ForEach-Object { $rule=$_; $_ | Get-NetFirewallSecurityFilter | Select-Object LocalUser,RemoteUser,Authentication,OverrideBlockRules,@{n='Rule';e={$rule.DisplayName}} })
  firewallAddresses=@(Get-NetFirewallRule -Enabled True -Direction Outbound -Action Block | ForEach-Object { $rule=$_; $_ | Get-NetFirewallAddressFilter | Select-Object LocalAddress,RemoteAddress,@{n='Rule';e={$rule.DisplayName}} })
  taskPrincipal=(Get-ScheduledTask CornGridSandboxAgent).Principal
 } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $PSScriptRoot 'broker-network-inspect.json')
 exit
}
$liveRoot='C:\CornGrid\Sandbox\Users\sbx_5d70f3b9d9a6c652b4'
if (-not (Test-Path -LiteralPath $liveRoot)) { throw 'This sandbox was deleted. Select an active instance before running this repair.' }
$liveTerminal=Join-Path $liveRoot 'terminal64.exe'
$liveBackup=Join-Path $liveRoot ('broker-diagnostic-backup-'+(Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $liveBackup | Out-Null
Stop-ScheduledTask CornGridSandboxAgent
Get-ScheduledTask CornGridInspectDesktop -ErrorAction SilentlyContinue | Stop-ScheduledTask
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $liveTerminal } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-ChildItem -LiteralPath (Join-Path $liveRoot 'broker-diagnostic-backup-20261105-185216') -Filter '*.ex5' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $liveRoot 'MQL5\Experts\CornGrid') -Force }
foreach ($liveFile in @('servers.dat','terminal.lic','dnsperf.dat')) {
 $livePath=Join-Path $liveRoot ('config\'+$liveFile)
 if (Test-Path -LiteralPath $livePath) { Move-Item -LiteralPath $livePath -Destination (Join-Path $liveBackup $liveFile) }
 if ($liveFile -ne 'dnsperf.dat') { Copy-Item -LiteralPath (Join-Path 'C:\Program Files\LiteFinance MT5 Terminal\config' $liveFile) -Destination $livePath }
}
Copy-Item -LiteralPath 'C:\Website\Website\Corngrid-web\agent\mt5-manager.js' -Destination (Join-Path $liveBackup 'mt5-manager.js')
Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'Corngrid-web\agent\mt5-manager.js') -Destination 'C:\Website\Website\Corngrid-web\agent\mt5-manager.js' -Force
Start-ScheduledTask CornGridSandboxAgent
@{success=$true;backup=$liveBackup;eaRestored=$true;brokerVendorCache=$true;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $liveResult
