param([string]$AgentDir,[string]$ExpectedHost,[ValidateSet('Baseline','Final')][string]$Mode='Final')
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $ExpectedHost){throw 'Wrong node verification target.'}
$AgentDir=[IO.Path]::GetFullPath($AgentDir)
if($AgentDir -notin @('C:\Website\Website\Corngrid-web\agent','C:\CornGrid\agent')){throw 'Unexpected agent directory.'}
$config=Get-Content -LiteralPath (Join-Path $AgentDir 'agent-config.json') -Raw|ConvertFrom-Json
$out=Join-Path $PSScriptRoot ('node-updater-verification-'+$ExpectedHost.ToLowerInvariant()+'-result.json')
$report=[ordered]@{hostname=[string]$env:COMPUTERNAME;mode=$Mode;phase='starting';at=[DateTime]::UtcNow.ToString('o')}
try{
 $pointer=Get-Content -LiteralPath (Join-Path $config.agentDataDir 'agent-active-release.json') -Raw|ConvertFrom-Json
 if($pointer.active -notmatch '^[a-f0-9]{64}$' -or $pointer.sequence -lt 1 -or $pointer.phase -ne 'ok'){throw 'Agent activation is not committed.'}
 $release=Join-Path $config.agentDataDir ('node-releases\'+$pointer.active+'-'+$pointer.sequence)
 $envelope=Get-Content -LiteralPath (Join-Path $release 'release-envelope.json') -Raw|ConvertFrom-Json
 $payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload))|ConvertFrom-Json
 $mismatches=@();foreach($file in $payload.files){
  if($file.name -notmatch '^[a-z][a-z0-9.-]+$' -or $file.name.Contains('..')){throw 'Unsafe release filename.'}
  if((Get-FileHash -LiteralPath (Join-Path $release $file.name)).Hash.ToLowerInvariant() -ne $file.sha256){$mismatches+=$file.name}
 }
 $report.releaseId=$pointer.active;$report.sequence=$pointer.sequence;$report.version=$payload.version;$report.activeFileHashesMatch=$mismatches.Count -eq 0
 $report.taskState=[string](Get-ScheduledTask CornGridSandboxManagedAgent).State
 $report.legacyDisabled=-not [bool](Get-ScheduledTask CornGridSandboxAgent).Settings.Enabled
 $processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
 $report.launcherCount=@($processes|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $AgentDir 'agent-launcher.js'),[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count
 $report.agentCount=@($processes|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $release 'agent.js'),[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count
 $terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{@{pid=$_.Id;path=$_.Path}})
 $report.runningTerminals=$terminals
 $report.configHash=(Get-FileHash -LiteralPath (Join-Path $AgentDir 'agent-config.json')).Hash
 $report.freeDiskMb=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
 $baseline=Join-Path $config.agentDataDir 'auto-update-continuity-baseline.json'
 if($Mode -eq 'Baseline'){
  [IO.File]::WriteAllText($baseline,(@{terminals=$terminals;configHash=$report.configHash;releaseId=$report.releaseId;version=$report.version}|ConvertTo-Json -Depth 6))
 }else{
  $before=Get-Content -LiteralPath $baseline -Raw|ConvertFrom-Json
  $report.configUnchanged=$report.configHash -eq $before.configHash
  $report.baselineVersion=$before.version;$report.baselineRelease=$before.releaseId
  $changed=@();foreach($terminal in $before.terminals){$now=$terminals|Where-Object{$_.pid -eq $terminal.pid -and $_.path -eq $terminal.path};if(-not $now){$changed+=@{pid=$terminal.pid;path=$terminal.path}}}
  $report.changedTerminals=$changed;$report.terminalPidsPreserved=$changed.Count -eq 0
 }
 if(-not $report.activeFileHashesMatch -or $report.launcherCount -ne 1 -or $report.agentCount -ne 1 -or $report.taskState -ne 'Running'){throw 'Managed agent verification failed.'}
 $report.phase='complete'
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
$json=$report|ConvertTo-Json -Depth 7 -Compress
[IO.File]::WriteAllText($out,$json)
[IO.File]::WriteAllText((Join-Path $config.agentDataDir 'auto-update-verification.json'),$json)
