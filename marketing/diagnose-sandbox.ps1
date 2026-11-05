$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
@{
 processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','terminal64.exe') } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
 tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -match 'CornGrid|Sandbox|MT5' } | ForEach-Object { @{name=$_.TaskName;state=$_.State.ToString();user=$_.Principal.UserId;execute=$_.Actions.Execute;arguments=$_.Actions.Arguments} })
 desktopUsers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner; @{session=$_.SessionId;user=($owner.Domain+'\'+$owner.User)} })
 services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'CornGrid|Sandbox|MT5' } | Select-Object Name,State,PathName)
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $PSScriptRoot 'sandbox-diagnostic.json')
