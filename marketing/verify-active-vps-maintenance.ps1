$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Wrong node.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$r=[ordered]@{hostname=$env:COMPUTERNAME;phase='complete';at=[DateTime]::UtcNow.ToString('o')}
$os=Get-CimInstance Win32_OperatingSystem;$r.totalRamMb=[math]::Round($os.TotalVisibleMemorySize/1024);$r.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);$r.freeDiskMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
$r.programs=@();foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')){$r.programs+=@(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName}|Select-Object DisplayName,DisplayVersion)}
$r.processes=@(Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 15|ForEach-Object{@{pid=$_.Id;name=$_.ProcessName;mb=[math]::Round($_.WorkingSet64/1MB)}})
$r.mt5PidPreserved=[bool](Get-Process -Id 4044 -ErrorAction SilentlyContinue);$r.agentPidPreserved=[bool](Get-Process -Id 13440 -ErrorAction SilentlyContinue)
$r.agentTask=[string](Get-ScheduledTask -TaskName 'CornGridSandboxManagedAgent').State
$r.webviewPreserved=Test-Path -LiteralPath 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
$r.defender=(Get-Service -Name WinDefend).Status.ToString();$r.remoteDesktop=(Get-Service -Name TermService).Status.ToString()
$r.optionalServices=@();foreach($name in @('SysMain','DiagTrack','WSearch','Spooler')){$service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'");if($service){$r.optionalServices+=@{name=$name;state=$service.State;startMode=$service.StartMode}}}
$r.browserRemainders=@();foreach($root in @('C:\Program Files\Google','C:\Program Files (x86)\Google','C:\Program Files (x86)\Microsoft\Edge','C:\Program Files (x86)\Microsoft\EdgeCore','C:\Program Files (x86)\Microsoft\EdgeWebView','C:\Program Files (x86)\Microsoft\EdgeUpdate')){
 if(Test-Path -LiteralPath $root){$r.browserRemainders+=@{path=$root;children=@(Get-ChildItem -LiteralPath $root -Force|Select-Object Name,PSIsContainer,Length);largestFiles=@(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue|Sort-Object Length -Descending|Select-Object -First 5|ForEach-Object{@{path=$_.FullName;mb=[math]::Round($_.Length/1MB,1)}})}}
}
$r.pendingReboot=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
[IO.File]::WriteAllText((Join-Path $workspace 'marketing\second-vps-maintenance-verify-result.json'),($r|ConvertTo-Json -Depth 7 -Compress))
