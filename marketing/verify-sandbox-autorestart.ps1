$ErrorActionPreference = 'Stop'
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
$taskResult = Join-Path $PSScriptRoot 'sandbox-autorestart-result.json'
try {
 $task = Get-ScheduledTask -TaskName CornGridSandboxAgent
 $taskBackup = Join-Path $PSScriptRoot ('agent-task-before-autorestart-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.xml')
 Export-ScheduledTask -TaskName CornGridSandboxAgent | Set-Content -LiteralPath $taskBackup
 # IgnoreNew makes this a watchdog: an existing healthy agent keeps running.
 $taskWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
 $taskLogon = New-ScheduledTaskTrigger -AtLogOn -User $task.Principal.UserId
 $taskSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
 Set-ScheduledTask -TaskName CornGridSandboxAgent -Trigger @((New-ScheduledTaskTrigger -AtStartup), $taskLogon, $taskWatchdog) -Settings $taskSettings | Out-Null
 # Simulate an agent restart while preserving the terminal and its positions.
 $taskTerminalPath = 'C:\CornGrid\Sandbox\Users\sbx_84446930a077903578\terminal64.exe'
 $taskOld = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $taskTerminalPath }
 if (@($taskOld).Count -ne 1) { throw 'Expected exactly one target sandbox terminal.' }
 Stop-ScheduledTask -TaskName CornGridSandboxAgent
 Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 Start-ScheduledTask -TaskName CornGridSandboxAgent
 Start-Sleep -Seconds 20
 $taskPreserved = [bool](Get-Process -Id $taskOld.ProcessId -ErrorAction SilentlyContinue)
 $taskRecovered = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $taskTerminalPath } | Select-Object -First 1
 if (-not $taskRecovered) { throw 'Terminal did not recover after agent restart.' }
 # Verify that the restarted agent adopts and recovers a terminal that closes.
 Stop-Process -Id $taskRecovered.ProcessId -Force
 $taskNew = $null
 for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
  Start-Sleep -Seconds 2
  $taskNew = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $taskTerminalPath -and $_.ProcessId -ne $taskRecovered.ProcessId } | Select-Object -First 1
  if ($taskNew) { break }
 }
 if (-not $taskNew) { throw 'Terminal did not restart within 60 seconds.' }
 $taskXml = Export-ScheduledTask -TaskName CornGridSandboxAgent
 @{success=$true;oldPid=$taskRecovered.ProcessId;newPid=$taskNew.ProcessId;session=$taskNew.SessionId;agentRestartPreservedTerminal=$taskPreserved;agentRestartRecoveredTerminal=$true;terminalRestartVerified=$true;startupTrigger=($taskXml -match '<BootTrigger');logonTrigger=($taskXml -match '<LogonTrigger');watchdogEveryMinute=($taskXml -match 'PT1M');requiresWindowsSignIn=$true;backup=$taskBackup} | ConvertTo-Json | Set-Content -LiteralPath $taskResult
} catch {
 @{success=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $taskResult
 throw
}
