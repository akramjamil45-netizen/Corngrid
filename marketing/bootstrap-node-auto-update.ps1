param([ValidateSet('Prepare','Finish')][string]$Phase,[string]$AgentDir,[string]$SourceAgentDir,[string]$ExpectedHost,[string]$ExpectedNodeUid)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $ExpectedHost -or $ExpectedNodeUid -notmatch '^node_[a-f0-9]{18}$'){throw 'Unexpected bootstrap target.'}
$AgentDir=[IO.Path]::GetFullPath($AgentDir)
if($AgentDir -notin @('C:\Website\Website\Corngrid-web\agent','C:\CornGrid\agent')){throw 'Agent directory is not an approved target.'}
$resultFile=Join-Path $PSScriptRoot ('node-updater-'+$ExpectedHost.ToLowerInvariant()+'-result.json')
$legacy='CornGridSandboxAgent';$managed='CornGridSandboxManagedAgent'
$report=[ordered]@{phase='starting';operation=$Phase;hostname=[string]$env:COMPUTERNAME;nodeUid=$ExpectedNodeUid;agentDir=$AgentDir}
function Report {[IO.File]::WriteAllText($resultFile,($report|ConvertTo-Json -Depth 7 -Compress))}
try{
 $configFile=Join-Path $AgentDir 'agent-config.json';$config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
 if($config.nodeUid -ne $ExpectedNodeUid){throw 'Node identity mismatch.'}
 $saved=Join-Path $config.agentDataDir 'auto-update-bootstrap-state.json'
 if($Phase -eq 'Prepare'){
  if($config.backendUrl -match '^http://(?:localhost|127\.0\.0\.1)(?::3000)?/?$'){
   $configBackup=Join-Path $config.agentDataDir 'auto-update-backend-origin-before.json'
   if(-not(Test-Path -LiteralPath $configBackup)){Copy-Item -LiteralPath $configFile -Destination $configBackup}
   $config.backendUrl='https://corngrid.com'
   [IO.File]::WriteAllText($configFile,($config|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
   $report.backendOriginChanged=$true;$report.backendOrigin='https://corngrid.com'
  }
  $oldTask=Get-ScheduledTask -TaskName $legacy
  $currentManaged=Get-ScheduledTask -TaskName $managed -ErrorAction SilentlyContinue
  if($currentManaged -and $currentManaged.State -eq 'Running'){$report.phase='already-managed';Report;exit}
  $terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{@{pid=$_.Id;path=$_.Path}})
  $oldAgents=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $AgentDir 'agent.js'),[StringComparison]::OrdinalIgnoreCase) -ge 0}|ForEach-Object{$_.ProcessId})
  if($oldAgents.Count -ne 1){throw 'Expected one legacy agent before handover.'}
  $state=@{nodeUid=$ExpectedNodeUid;configHash=(Get-FileHash -LiteralPath $configFile).Hash;oldPids=$oldAgents;terminals=$terminals;legacyWasEnabled=[bool]$oldTask.Settings.Enabled;taskUser=[string]$oldTask.Principal.UserId}
  New-Item -ItemType Directory -Path $config.agentDataDir -Force|Out-Null
  [IO.File]::WriteAllText($saved,($state|ConvertTo-Json -Depth 6))
  $manifest=Get-Content -LiteralPath (Join-Path $SourceAgentDir 'RELEASE.json') -Raw|ConvertFrom-Json
  $files=@($manifest.files|ForEach-Object{[string]$_.name})+@('agent-launcher.js','install-service.ps1','uninstall-service.ps1','agent-config.example.json','RELEASE.json')
  foreach($name in $files){
   if($name -notmatch '^[a-z][a-z0-9.-]+$' -or $name.Contains('..') -or $name -eq 'agent-config.json'){throw 'Unsafe bootstrap file.'}
   $source=Join-Path $SourceAgentDir $name;$target=Join-Path $AgentDir $name
   if([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($target)){Copy-Item -LiteralPath $source -Destination $target -Force}
   if((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash){throw 'Bootstrap file hash mismatch.'}
  }
  $node='C:\Program Files\nodejs\node.exe';$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
  Set-Location -LiteralPath $AgentDir
  $ErrorActionPreference='Continue';& $node '.\check-installation.js' --online *> (Join-Path $config.agentDataDir 'updater-bootstrap-check.log');$check=$LASTEXITCODE;$ErrorActionPreference='Stop'
  if($check -ne 0){throw 'Existing node installation diagnostics failed.'}
  if(-not(Test-Path -LiteralPath (Join-Path $AgentDir 'update-trust.pem'))){
   $ErrorActionPreference='Continue';& $node '.\agent-launcher.js' --trust-update-key *> (Join-Path $config.agentDataDir 'updater-bootstrap-trust.log');$pin=$LASTEXITCODE;$ErrorActionPreference='Stop'
   if($pin -ne 0){throw 'Unable to pin the central update public key.'}
  }
  Disable-ScheduledTask -TaskName $legacy|Out-Null
  if(-not $currentManaged){& '.\install-service.ps1' -Mode Interactive -TaskName $managed -UserId $state.taskUser -NoStart}
  Disable-ScheduledTask -TaskName $managed|Out-Null
  if((Get-FileHash -LiteralPath $configFile).Hash -ne $state.configHash){throw 'Private node config changed.'}
  $report.phase='prepared';$report.legacyPids=$oldAgents;$report.preservedTerminalCount=$terminals.Count;$report.keyPinned=$true;$report.managedTaskDisabled=$true
 }else{
  $state=Get-Content -LiteralPath $saved -Raw|ConvertFrom-Json
  if($state.nodeUid -ne $ExpectedNodeUid){throw 'Invalid bootstrap state.'}
  $deadline=(Get-Date).AddSeconds(20)
  do{$alive=@($state.oldPids|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue});if(-not $alive.Count){break};Start-Sleep -Seconds 1}while((Get-Date) -lt $deadline)
  if($alive.Count){throw 'Legacy agent is still running. Do not start a duplicate agent.'}
  $changed=@();foreach($terminal in $state.terminals){$process=Get-Process -Id $terminal.pid -ErrorAction SilentlyContinue;if(-not $process -or $process.Path -ne $terminal.path){$changed+=@{pid=$terminal.pid;path=$terminal.path}}}
  $report.changedOriginalTerminals=$changed
  Enable-ScheduledTask -TaskName $managed|Out-Null
  if((Get-ScheduledTask -TaskName $managed).State -ne 'Running'){Start-ScheduledTask -TaskName $managed}
  Start-Sleep -Seconds 6
  $report.phase='managed-running';$report.taskState=[string](Get-ScheduledTask -TaskName $managed).State
  $report.configUnchanged=(Get-FileHash -LiteralPath $configFile).Hash -eq $state.configHash
  $report.allOriginalTerminalsRunning=@($state.terminals|Where-Object{Get-Process -Id $_.pid -ErrorAction SilentlyContinue}).Count -eq @($state.terminals).Count
  $report.preservedTerminalCount=@($state.terminals).Count
  $report.taskName=$managed;$report.legacyDisabled=-not [bool](Get-ScheduledTask -TaskName $legacy).Settings.Enabled
  if($changed.Count){$report.phase='managed-running-terminal-recovery'}
  if($report.taskState -ne 'Running' -or -not $report.configUnchanged){throw 'Managed node verification failed.'}
 }
}catch{
 $report.phase='failed';$report.error=[string]$_.Exception.Message
 if($Phase -eq 'Prepare'){try{Enable-ScheduledTask -TaskName $legacy|Out-Null}catch{}}
 Report;throw
}
Report
