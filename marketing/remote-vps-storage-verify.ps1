$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong target VPS/account.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\remote-vps-storage-verify-result.json'
$report=[ordered]@{hostname=[string]$env:COMPUTERNAME;phase='starting';verifiedAtUtc=[DateTime]::UtcNow.ToString('o')}
try{
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong CornGrid node.'}
 $audit=Get-Content -LiteralPath (Join-Path $workspace 'marketing\remote-vps-storage-audit-result.json') -Raw|ConvertFrom-Json
 $cleanup=Get-Content -LiteralPath (Join-Path $workspace 'marketing\remote-vps-storage-cleanup-result.json') -Raw|ConvertFrom-Json
 $report.freeDiskMbBefore=$audit.freeDiskMb
 $report.freeDiskMbAfter=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
 $report.reclaimedMb=$report.freeDiskMbAfter-$report.freeDiskMbBefore
 $report.freeRamMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
 $report.firefoxExecutablePresent=Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe'
 $report.mozillaPrograms=@();foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')){
  $report.mozillaPrograms+=@(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue|Where-Object{$_.Publisher -like '*Mozilla*'}|ForEach-Object{[string]$_.DisplayName})
 }
 $report.services=@(Get-CimInstance Win32_Service|Where-Object{$_.Name -in @('DiagTrack','SysMain','MozillaMaintenance','WinDefend','mpssvc','TermService','Schedule','wuauserv','BITS')}|ForEach-Object{@{name=$_.Name;state=$_.State;startMode=$_.StartMode}})
 $report.browserPolicies=@();foreach($policy in @(@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='StartupBoostEnabled'},@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='BackgroundModeEnabled'},@{key='HKLM:\SOFTWARE\Policies\Google\Chrome';name='BackgroundModeEnabled'})){
  $value=(Get-Item -LiteralPath $policy.key).GetValue($policy.name)
  $report.browserPolicies+=@{key=$policy.key;name=$policy.name;value=$value}
 }
 $report.originalMt5Running=[bool](Get-Process -Id 3172 -ErrorAction SilentlyContinue)
 $report.agentTaskState=[string](Get-ScheduledTask -TaskName 'CornGridSandboxAgent').State
 $report.agentProcessCount=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf('C:\CornGrid\agent\agent.js',[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count
 $report.pendingWindowsReboot=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
 $report.settingsBackup=$cleanup.settingsBackup
 Set-Location -LiteralPath 'C:\CornGrid\agent'
 $log='C:\CornGrid\Sandbox\AgentData\maintenance-installation-check.log'
 $ErrorActionPreference='Continue'
 & 'C:\Program Files\nodejs\node.exe' '.\check-installation.js' --online *> $log
 $exit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 $report.installationCheckExitCode=$exit;$report.installationCheckLog=[IO.File]::ReadAllText($log)
 if($exit -ne 0){throw 'Post-cleanup installation diagnostics failed.'}
 if($report.firefoxExecutablePresent -or $report.mozillaPrograms.Count){throw 'Mozilla program remnants remain registered.'}
 if(@($report.browserPolicies|Where-Object{$_.value -ne 0}).Count){throw 'A browser background policy was not applied.'}
 if(@($report.services|Where-Object{$_.name -in @('DiagTrack','SysMain') -and ($_.state -ne 'Stopped' -or $_.startMode -ne 'Disabled')}).Count){throw 'An optional background service is not disabled.'}
 if(-not $report.originalMt5Running -or $report.agentTaskState -ne 'Running' -or $report.agentProcessCount -ne 1){throw 'An existing trading/agent process is not healthy.'}
 $report.phase='complete'
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
$json=$report|ConvertTo-Json -Depth 7 -Compress
[IO.File]::WriteAllText($out,$json)
[IO.File]::WriteAllText('C:\CornGrid\Sandbox\AgentData\maintenance-result.json',$json)
