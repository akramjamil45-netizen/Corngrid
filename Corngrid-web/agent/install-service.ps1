# Interactive mode preserves the Windows account/session used for MT5 setup.
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [ValidateSet('Interactive','System')][string]$Mode='Interactive',
    [ValidatePattern('^[A-Za-z0-9_-]{1,80}$')][string]$TaskName='CornGridSandboxAgent',
    [string]$UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [switch]$Replace,
    [switch]$NoStart
)
$ErrorActionPreference='Stop'
$AgentDir=$PSScriptRoot
$AgentScript=Join-Path $AgentDir 'agent-launcher.js'
$NodeExe=(Get-Command node.exe -ErrorAction Stop).Source
foreach($file in @('agent.js','agent-launcher.js','auto-update.js','update-protocol.js','agent-config.json','check-installation.js','source-compiler.js','broker-resolution.js','resolve-broker.ps1','broker-probe.py')){
    if(-not (Test-Path -LiteralPath (Join-Path $AgentDir $file) -PathType Leaf)){throw "Required agent file missing: $file"}
}
try{$null=Get-Content -LiteralPath (Join-Path $AgentDir 'agent-config.json') -Raw | ConvertFrom-Json}catch{throw 'agent-config.json is invalid JSON. Configuration contents are not printed.'}
$existing=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($existing -and -not $Replace){throw "Task '$TaskName' already exists. Review it first; use -Replace only for an intentional update."}
if($existing -and $existing.State -eq 'Running'){throw 'The existing task is running. Plan a maintenance stop before replacing it; this installer will not stop trading processes.'}
$action=New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$AgentScript`"" -WorkingDirectory $AgentDir
if($Mode -eq 'System'){
    Write-Warning 'SYSTEM uses a different Windows session. Test broker discovery and protected WebRequest settings in that context before accepting users.'
    $trigger=New-ScheduledTaskTrigger -AtStartup
    $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}else{
    if([string]::IsNullOrWhiteSpace($UserId)){throw 'Choose the same Windows user that was used to prepare MT5.'}
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $principal=New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
}
# Some Windows schedulers consider a launched program completed even when it
# exits with code 1. A repeating trigger also recovers that case. IgnoreNew
# keeps the existing agent alive and prevents a second task instance.
# Omit RepetitionDuration for indefinite recovery (do not use TimeSpan::MaxValue).
$recoveryTrigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$recoveryTrigger.Repetition.StopAtDurationEnd=$false
$triggers=@($trigger,$recoveryTrigger)
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if($PSCmdlet.ShouldProcess($TaskName,"Register $Mode CornGrid agent task")){
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force:$Replace | Out-Null
    if(-not $NoStart){Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop}
    Write-Host "Registered '$TaskName' in $Mode mode. Check task state, last result and the node heartbeat in CornGrid Admin."
    Write-Host 'Recovery trigger retries an exited agent every minute; IgnoreNew prevents duplicate task instances. Disable the task before an intentional maintenance stop.'
    if($Mode -eq 'Interactive'){Write-Host 'Starts at Windows logon. Keep that session logged on; disconnect RDP instead of signing out.'}
}
