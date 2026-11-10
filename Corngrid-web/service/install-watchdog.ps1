param([string]$ProjectDir='C:\Website\Website\Corngrid-web')
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run watchdog installation as Administrator'}
$script=Join-Path $ProjectDir 'service\watchdog.ps1'
if(-not (Test-Path -LiteralPath $script)){throw 'Watchdog script is missing'}
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$script+'"')
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$boot=New-ScheduledTaskTrigger -AtStartup
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$identity=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName CornGridWebsiteWatchdog -Action $action -Trigger @($trigger,$boot) -Settings $settings -Principal $identity -Force | Out-Null
Start-ScheduledTask -TaskName CornGridWebsiteWatchdog
Write-Output 'Website watchdog installed: 3 consecutive failures, 10 minute recovery cooldown, every minute.'
