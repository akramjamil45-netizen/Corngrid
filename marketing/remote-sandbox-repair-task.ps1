$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong target host/account.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\remote-sandbox-task-result.json'
$report=@{hostname=[string]$env:COMPUTERNAME;phase='starting'}
try{
 $agent='C:\CornGrid\agent'
 $config=Get-Content -LiteralPath (Join-Path $agent 'agent-config.json') -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong node identity.'}
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent'
 if($task.State -eq 'Running'){throw 'Agent task must be idle before replacement.'}
 if($task.Actions.Execute -ne 'C:\Program Files\nodejs\node.exe' -or $task.Actions.Arguments -ne '"C:\CornGrid\agent\agent.js"'){throw 'Unexpected existing task action.'}
 $running=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf('C:\CornGrid\agent\agent.js',[StringComparison]::OrdinalIgnoreCase) -ge 0})
 if($running.Count){throw 'An existing agent process is still running.'}
 if(@(Get-ChildItem -LiteralPath $config.sandboxUsersDir -Directory -ErrorAction SilentlyContinue).Count){throw 'Unexpected customer sandbox directories on new node.'}
 [IO.File]::WriteAllText('C:\CornGrid\Sandbox\AgentData\task-before-recovery.xml',(Export-ScheduledTask -TaskName 'CornGridSandboxAgent'))
 Copy-Item -LiteralPath (Join-Path $workspace 'Corngrid-web\agent\install-service.ps1') -Destination (Join-Path $agent 'install-service.ps1') -Force
 $env:PATH='C:\Program Files\nodejs;'+$env:PATH
 & (Join-Path $agent 'install-service.ps1') -Mode Interactive -Replace -NoStart
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent'
 $info=Get-ScheduledTaskInfo -TaskName 'CornGridSandboxAgent'
 $report.phase='waiting-for-automatic-start';$report.taskState=[string]$task.State
 $report.triggerCount=@($task.Triggers).Count
 $report.recoveryIntervals=@($task.Triggers|Where-Object{$_.Repetition.Interval}|ForEach-Object{[string]$_.Repetition.Interval})
 $report.nextRun=[string]$info.NextRunTime
 $report.manualStartUsed=$false
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress -Depth 5))
