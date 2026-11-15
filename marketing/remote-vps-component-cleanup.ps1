$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong target VPS/account.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-vps-storage-components-result.json'
$report=[ordered]@{hostname=[string]$env:COMPUTERNAME;phase='starting';resetBaseUsed=$false;rebootRequested=$false}
function Save-Report {[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 6 -Compress))}
function Free-DiskMb {return [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)}
function Run-Dism([string]$Mode,[string]$Prefix){
 $output=$Prefix+'.out.log';$errorLog=$Prefix+'.err.log'
 $args=@('/Online','/Cleanup-Image',('/'+$Mode),'/NoRestart','/English',('/LogPath:'+ $Prefix+'.dism.log'))
 $process=Start-Process -FilePath 'C:\Windows\System32\Dism.exe' -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errorLog -PassThru
 try{$process.PriorityClass='BelowNormal'}catch{}
 while(-not $process.WaitForExit(5000)){
  $lines=Get-Content -LiteralPath $output -Tail 5 -ErrorAction SilentlyContinue
  $percent=([regex]::Matches(($lines -join ' '),'\d+(?:\.\d+)?%')|Select-Object -Last 1).Value
  $report.progress=[string]$percent;Save-Report
 }
 $process.Refresh();return @{exitCode=$process.ExitCode;output=[IO.File]::ReadAllText($output)}
}
try{
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong CornGrid node.'}
 $report.freeDiskMbBefore=Free-DiskMb
 $active=@(Get-Process TiWorker,dism,setuphost,msiexec -ErrorAction SilentlyContinue)
 $installer=Get-Service TrustedInstaller -ErrorAction SilentlyContinue
 $pending=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
 $report.pendingWindowsReboot=[bool]$pending
 if($active.Count -or ($installer -and $installer.Status -eq 'Running')){$report.phase='skipped';$report.reason='Windows servicing is already active'}
 elseif($pending){$report.phase='skipped';$report.reason='Windows has pending servicing that requires a separate reboot maintenance window'}
 elseif($report.freeDiskMbBefore -lt 1000){$report.phase='skipped';$report.reason='Insufficient disk headroom for component servicing'}
 else{
  $prefix='C:\CornGrid\Sandbox\AgentData\component-analysis-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
  $report.phase='analyzing-component-store';Save-Report
  $analysis=Run-Dism 'AnalyzeComponentStore' $prefix
  $report.analysisExitCode=$analysis.exitCode;$report.analysis=$analysis.output
  if($analysis.exitCode -ne 0){throw 'DISM component analysis did not succeed.'}
  $report.cleanupRecommended=[bool]($analysis.output -match 'Component Store Cleanup Recommended\s*:\s*Yes')
  if($report.cleanupRecommended){
   $report.phase='cleaning-superseded-components';Save-Report
   $cleanup=Run-Dism 'StartComponentCleanup' ($prefix+'-cleanup')
   $report.cleanupExitCode=$cleanup.exitCode;$report.cleanupOutput=$cleanup.output
   if($cleanup.exitCode -notin @(0,3010)){throw 'DISM component cleanup did not succeed.'}
   $report.restartNeeded=$cleanup.exitCode -eq 3010
  }
  $report.phase='complete'
 }
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
$report.freeDiskMbAfter=Free-DiskMb
$report.reclaimedMb=$report.freeDiskMbAfter-$report.freeDiskMbBefore
Save-Report
