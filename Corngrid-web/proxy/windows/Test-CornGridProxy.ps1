[CmdletBinding()]
param([string]$InstallRoot='C:\CornGridProxy')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot)
$config=Get-Content -LiteralPath (Join-Path $root 'private\proxy-config.json') -Raw|ConvertFrom-Json
$task=Get-ScheduledTask -TaskName CornGridProxyServer -ErrorAction SilentlyContinue
$listen=@(Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction SilentlyContinue)
$report=[ordered]@{serverUid=$config.serverUid;taskState=if($task){$task.State.ToString()}else{'Missing'};tlsPort=$config.port;listening=($listen.Count -gt 0);certificateFingerprint=$config.certificateFingerprint;pfxPresent=(Test-Path -LiteralPath $config.pfxPath);sourceIPv4=@(Get-NetIPAddress -AddressFamily IPv4|Where-Object{$_.AddressState -eq 'Preferred'}|Select-Object -ExpandProperty IPAddress);note='Use CornGrid Admin to confirm backend heartbeat, verified public IP, enabled status and node assignment.'}
$report|ConvertTo-Json -Depth 4
