$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-postflight-result.json'
$report=@{phase='starting';hostname=[string]$env:COMPUTERNAME}
try{
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong node identity.'}
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent';$taskInfo=Get-ScheduledTaskInfo -TaskName 'CornGridSandboxAgent'
 $report.taskState=[string]$task.State;$report.taskUser=[string]$task.Principal.UserId;$report.logonType=[string]$task.Principal.LogonType;$report.taskLastResult=$taskInfo.LastTaskResult
 $report.restartOnFailureCount=$task.Settings.RestartCount;$report.multipleInstances=[string]$task.Settings.MultipleInstances
 $report.triggerCount=@($task.Triggers).Count
 $report.recoveryIntervals=@($task.Triggers|Where-Object{$_.Repetition.Interval}|ForEach-Object{[string]$_.Repetition.Interval})
 $processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf('C:\CornGrid\agent\agent.js',[StringComparison]::OrdinalIgnoreCase) -ge 0})
 $report.agentProcessCount=$processes.Count;$report.agentPids=@($processes|ForEach-Object{$_.ProcessId})
 $log=[IO.File]::ReadAllText('C:\CornGrid\Sandbox\AgentData\agent-recovery.log')
 $report.agentStartCount=[regex]::Matches($log,'CornGrid Sandbox Agent 1.1.0 started on VPS80481').Count
 $report.adminRestartReceived=$log.Contains('Restart command received from backend')
 $report.webSocketConnectionCount=[regex]::Matches($log,'Connected to the CornGrid backend \(WebSocket\)').Count
 $report.temporaryTestFolders=@(Get-ChildItem -LiteralPath 'C:\CornGrid\Diagnostics' -Directory -ErrorAction SilentlyContinue|Where-Object{$_.Name -like 'HostingSmoke-*'}).Count
 $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $report.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);$report.freeDiskMb=[math]::Round($disk.FreeSpace/1MB)
 $report.originalTerminalRunning=[bool](Get-Process -Id 3172 -ErrorAction SilentlyContinue)
 $readme=@'
CornGrid VPS80481 hosting node
Node ID: node_1677e8779f05aa567b
Maximum hosting capacity: 2 sandboxes
Backend: https://corngrid.com
Agent: C:\CornGrid\agent
MT5 clean runtime: C:\CornGrid\Sandbox\MT5
Customer sandboxes: C:\CornGrid\Sandbox\Users
Logs: C:\CornGrid\Sandbox\AgentData\agent-recovery.log
Scheduled Task: CornGridSandboxAgent
Windows task account: Administrator, Interactive logon, Highest privileges

Keep the Windows session logged in. Disconnect RDP instead of signing out.
After a VPS reboot, log in to this same Windows account to start the task.
Task retries after an agent failure; a real OS reboot recovery test remains a separate maintenance action.
An additional every-minute trigger recovers completed agent exits. IgnoreNew prevents duplicate task instances.
Disable the task before an intentional maintenance stop; otherwise the recovery trigger starts it again.

Node credentials are in agent\agent-config.json with private NTFS access.
Never share or commit that file. Do not reuse this Node ID/token on another machine.

This VPS exposes a legacy virtual CPU. NumPy 2.4+ requires CPU features it does not expose.
Installed broker tools: MetaTrader5 5.0.6231 and NumPy 2.3.5, Python 3.12.2 x64.
When updating broker tools, keep the compatibility constraint:
"C:\Program Files\Python312\python.exe" -m pip install --upgrade --no-cache-dir --target "C:\CornGrid\agent\broker-python" "MetaTrader5>=5.0,<6" "numpy<2.4"
Do not upgrade NumPy beyond that constraint until the VPS CPU features are changed and retested.

The node has 1.5 GB RAM and a nearly full 30 GB C: disk. Two allocated slots are a configured cap, not a guarantee of capacity for all EAs.
Monitor real RAM/disk/CPU before adding customer workloads. Do not delete existing MT5 folders or logs without reviewing their ownership.
Actual broker login, EA licensing and two simultaneous trading EAs require a separate demo-account acceptance test.
'@
 [IO.File]::WriteAllText('C:\CornGrid\README-VPS80481.txt',$readme)
 $report.phase='complete'
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress -Depth 5))
