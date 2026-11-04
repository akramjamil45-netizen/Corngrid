# CornGrid Sandbox Agent - Windows startup task installer.
# Registers a Scheduled Task that starts the agent at boot and restarts it on
# failure. Run from an elevated PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
#
# For production, running the agent under NSSM (nssm.exe) as a real Windows
# Service is recommended; see WINDOWS_AGENT_SETUP.md.

$ErrorActionPreference = 'Stop'

$TaskName = 'CornGridSandboxAgent'
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentScript = Join-Path $AgentDir 'agent.js'
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path $AgentScript)) {
    throw "agent.js not found in $AgentDir"
}

# Remove any previous registration.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$AgentScript`"" -WorkingDirectory $AgentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "CornGrid Sandbox Agent registered and started as scheduled task '$TaskName'."
Write-Host "Manage with: Get-ScheduledTask -TaskName $TaskName"
