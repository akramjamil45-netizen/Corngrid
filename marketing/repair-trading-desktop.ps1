param([switch]$ConfigureLogonOnly)
$ErrorActionPreference = 'Stop'
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 $taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
 if ($ConfigureLogonOnly) { $taskArguments += ' -ConfigureLogonOnly' }
 Start-Process powershell.exe -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
$taskResult = Join-Path $PSScriptRoot 'trading-desktop-result.json'
try {
 $taskExplorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -gt 0 } | Select-Object -First 1
 if (-not $taskExplorer) { throw 'No signed-in desktop user is available.' }
 $taskOwner = Invoke-CimMethod -InputObject $taskExplorer -MethodName GetOwner
 $taskUser = $taskOwner.Domain + '\' + $taskOwner.User
 $taskExisting = Get-ScheduledTask -TaskName CornGridSandboxAgent -ErrorAction Stop
 $taskLogon = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
 if ($ConfigureLogonOnly) {
  Set-ScheduledTask -TaskName CornGridSandboxAgent -Trigger @((New-ScheduledTaskTrigger -AtStartup), $taskLogon) | Out-Null
  @{success=$true;logonTrigger=$true;user=$taskUser} | ConvertTo-Json | Set-Content -LiteralPath $taskResult
  exit
 }
 $taskBackup = Join-Path $PSScriptRoot ('agent-task-before-trading-repair-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.xml')
 Export-ScheduledTask -TaskName CornGridSandboxAgent | Set-Content -LiteralPath $taskBackup
 Stop-ScheduledTask -TaskName CornGridSandboxAgent
 Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*C:\Website\Website\Corngrid-web\agent\agent.js*'
 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object {
  $_.ExecutablePath -eq 'C:\CornGrid\Sandbox\Users\sbx_84446930a077903578\terminal64.exe'
 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 $taskInteractive = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Highest
 Set-ScheduledTask -TaskName CornGridSandboxAgent -Principal $taskInteractive -Trigger @((New-ScheduledTaskTrigger -AtStartup), $taskLogon) | Out-Null
 Start-ScheduledTask -TaskName CornGridSandboxAgent
 @{success=$true;user=$taskUser;backup=$taskBackup;requiresSignedInDesktop=$true} | ConvertTo-Json | Set-Content -LiteralPath $taskResult
} catch {
 @{success=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $taskResult
 throw
}
