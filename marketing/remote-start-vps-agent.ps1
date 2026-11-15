$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-start-result.json'
$report=@{phase='starting';hostname=[string]$env:COMPUTERNAME;pid=$PID}
function Report { [IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress -Depth 4)) }
try{
 Report
 Set-Location -LiteralPath 'C:\CornGrid\agent'
 $identity=[IO.File]::ReadAllText('C:\CornGrid\agent\agent-config.json')|ConvertFrom-Json
 if($identity.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Unexpected node identity.'}
 $env:PATH='C:\Program Files\nodejs;'+$env:PATH
 $report.phase='checking';Report
 $ErrorActionPreference='Continue'
 & 'C:\Program Files\nodejs\node.exe' '.\check-installation.js' --online *> 'C:\CornGrid\installation-check-v3.log'
 $exitCode=$LASTEXITCODE;$ErrorActionPreference='Stop'
 $report.checkExit=$exitCode;$report.checkLog=[IO.File]::ReadAllText('C:\CornGrid\installation-check-v3.log');Report
 if($exitCode -ne 0){throw 'Installation checks failed.'}
 $report.phase='installing-task';Report
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent' -ErrorAction SilentlyContinue
 if(-not $task){& '.\install-service.ps1' -Mode Interactive -NoStart}
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent'
 if($task.State -ne 'Running'){Start-ScheduledTask -TaskName 'CornGridSandboxAgent'}
 Start-Sleep -Seconds 8
 $task=Get-ScheduledTask -TaskName 'CornGridSandboxAgent'
 $report.phase='complete';$report.taskState=[string]$task.State;$report.taskUser=[string]$task.Principal.UserId;$report.logonType=[string]$task.Principal.LogonType
 $report.agentLog=[IO.File]::ReadAllText('C:\CornGrid\Sandbox\AgentData\agent-recovery.log');Report
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message;Report}
