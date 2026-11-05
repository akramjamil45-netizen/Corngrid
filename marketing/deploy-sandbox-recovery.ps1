param([switch]$VerifyRestart,[switch]$RepairDesktop)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 $taskArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
 if ($VerifyRestart) { $taskArgs += ' -VerifyRestart' }
 if ($RepairDesktop) { $taskArgs += ' -RepairDesktop' }
 Start-Process powershell.exe -ArgumentList $taskArgs -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
$taskTarget = 'C:\Website\Website\Corngrid-web'
$taskSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'Corngrid-web'
$taskBackup = Join-Path $taskTarget ('storage\recovery-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
try {
 if (-not $VerifyRestart) {
  foreach ($taskFile in @('agent\agent.js','agent\transport.js','agent\mt5-manager.js','sandbox\sandbox-node-api.js')) {
   Copy-Item -LiteralPath (Join-Path $taskTarget $taskFile) -Destination (Join-Path $taskBackup ([IO.Path]::GetFileName($taskFile)))
   Copy-Item -LiteralPath (Join-Path $taskSource $taskFile) -Destination (Join-Path $taskTarget $taskFile) -Force
  }
  Stop-ScheduledTask -TaskName 'CornGridSandboxAgent'
  # Stop only the agent itself; keep all running trading terminals intact.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
   $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($RepairDesktop) {
   Export-ScheduledTask -TaskName 'CornGridSandboxAgent' | Set-Content (Join-Path $taskBackup 'agent-task.xml')
   $taskExplorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1
   $taskOwner = Invoke-CimMethod -InputObject $taskExplorer -MethodName GetOwner
   $taskUser = $taskOwner.Domain + '\' + $taskOwner.User
   # A dedicated desktop for this user avoids the exhausted SYSTEM desktop.
   # S4U runs at boot without storing a password or requiring a logged-in user.
   $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Highest
   Set-ScheduledTask -TaskName 'CornGridSandboxAgent' -Principal $taskPrincipal | Out-Null
   Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object {
    $_.ExecutablePath -eq 'C:\CornGrid\Sandbox\Users\sbx_84446930a077903578\terminal64.exe'
   } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $taskSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Set-ScheduledTask -TaskName 'CornGridSandboxAgent' -Settings $taskSettings | Out-Null
 }
 Restart-Service CornGridWeb
 for ($taskTry=0; $taskTry -lt 20; $taskTry++) {
  try { $taskHealth=Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 3; if ($taskHealth.status -eq 'ok') { break } } catch {}
  Start-Sleep -Seconds 1
 }
 if ($taskHealth.status -ne 'ok') { throw 'Backend health check failed' }
 if (-not $VerifyRestart) { Start-ScheduledTask -TaskName 'CornGridSandboxAgent' }
 @{success=$true;verifyRestart=[bool]$VerifyRestart;task=(Get-ScheduledTask -TaskName 'CornGridSandboxAgent').State.ToString();backup=$taskBackup;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'sandbox-recovery-result.json')
} catch {
 @{success=$false;error=$_.Exception.Message;backup=$taskBackup} | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'sandbox-recovery-result.json')
 throw
}
