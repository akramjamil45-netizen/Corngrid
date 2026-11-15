$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'local-node-updater-inspect-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Elevated node inventory failed.'};exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong source host.'}
$report=@{hostName=[string]$env:COMPUTERNAME}
$report.agents=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine -match '(?:agent\.js|sandbox.*agent)' -and $_.Name -match 'node|powershell|cmd'}|ForEach-Object{@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;exe=$_.ExecutablePath;command=$_.CommandLine}})
$report.tasks=@(Get-ScheduledTask|Where-Object{($_.Actions.Arguments -join ' ') -match '(?:agent\.js|sandbox.*agent)' -or $_.TaskName -like '*Sandbox*'}|ForEach-Object{@{name=$_.TaskName;state=[string]$_.State;user=$_.Principal.UserId;logonType=[string]$_.Principal.LogonType;actions=@($_.Actions|ForEach-Object{@{exe=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory}})}})
$report.services=@(Get-CimInstance Win32_Service|Where-Object{$_.Name -like '*CornGrid*' -or $_.Name -like '*Sandbox*'}|Select-Object Name,StartName,State,ProcessId,PathName)
$report.terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{@{pid=$_.Id;path=$_.Path;sessionId=$_.SessionId}})
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 7 -Compress))
