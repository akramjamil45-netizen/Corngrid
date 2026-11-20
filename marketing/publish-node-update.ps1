param([switch]$SkipTests,[switch]$AgentTestsOnly,[string]$PythonPath='')
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"'+$(if($SkipTests){' -SkipTests'}else{''})+$(if($AgentTestsOnly){' -AgentTestsOnly'}else{''})+$(if($PythonPath){' -PythonPath "'+$PythonPath+'"'}else{''})
 $child=Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Central agent publication failed. Inspect the publication result/log.'};exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Run this central deployment helper on WINSLET.'}
$source=Split-Path -Parent $PSScriptRoot;$target='C:\Website\Website';$runtime='C:\ProgramData\CornGrid\NodeUpdates'
$out=Join-Path $PSScriptRoot 'node-auto-update-publication-result.json'
$report=[ordered]@{phase='starting';websiteRestarted=$false;nodeRestartCommandsSent=0}
try{
 if(-not(Test-Path -LiteralPath (Join-Path $runtime 'signing-key.pem'))){throw 'Run initial auto-update deployment first.'}
 if(-not $SkipTests){
  Push-Location (Join-Path $source 'Corngrid-web')
  try{
   $ErrorActionPreference='Continue'
   if($AgentTestsOnly){
    $agentTests=@(Get-ChildItem -LiteralPath test -File|Where-Object{$_.Name -match '^(agent-|broker-|ipc-|linux-agent|mt5-startup|node-|sandbox-api|sandbox-realtime|source-compiler|partner-publication).*\.test\.js$'}|ForEach-Object{'test/'+$_.Name})
    if($agentTests.Count -lt 10){throw 'Incomplete agent regression selection.'}
    & node.exe --test --test-concurrency=1 $agentTests *> (Join-Path $runtime 'prepublication-tests.log')
   }else{& node.exe --test --test-concurrency=1 'test/*.test.js' *> (Join-Path $runtime 'prepublication-tests.log')}
   $testExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
  }finally{Pop-Location}
  if($testExit -ne 0){throw 'Pre-publication tests failed; no source was deployed.'}
  if(-not $PythonPath){$PythonPath=Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'}
  if(-not(Test-Path -LiteralPath $PythonPath -PathType Leaf)){throw 'Specify -PythonPath for the broker regression tests; no source was deployed.'}
  $ErrorActionPreference='Continue'
  & $PythonPath -B (Join-Path $source 'Corngrid-web\test\broker_probe_test.py') *> (Join-Path $runtime 'prepublication-python-tests.log')
  $pythonExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
  if($pythonExit -ne 0){throw 'Python broker regression tests failed; no source was deployed.'}
 }
 $report.testsScope=$(if($SkipTests){'previously-verified'}elseif($AgentTestsOnly){'agent-and-sandbox-regressions'}else{'full-project'})
 & (Join-Path $source 'Corngrid-web\scripts\build-node-agent.ps1')
 & node.exe (Join-Path $source 'Corngrid-web\scripts\build-linux-node-agent.js')
 if($LASTEXITCODE -ne 0){throw 'Linux installer build failed; no source was deployed.'}
 $manifest=Get-Content -LiteralPath (Join-Path $source 'Corngrid-web\agent\RELEASE.json') -Raw|ConvertFrom-Json
 $backup=Join-Path $runtime ('source-before-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'));New-Item -ItemType Directory -Path $backup|Out-Null
 # Existing launchers are bootstrap infrastructure, not child-agent releases.
 # Their updated copies are in the installers for fresh nodes. Preserve live
 # task launchers, service scripts, node identity and private configuration.
 $names=@($manifest.files|ForEach-Object{[string]$_.name})+@('agent-config.example.json')
 foreach($name in $names){
  if($name -notmatch '^[a-z][a-z0-9.-]+$' -or $name.Contains('..') -or $name -eq 'agent-config.json'){throw 'Unsafe source filename.'}
  $from=Join-Path $source ('Corngrid-web\agent\'+$name);$to=Join-Path $target ('Corngrid-web\agent\'+$name)
  if(Test-Path -LiteralPath $to){Copy-Item -LiteralPath $to -Destination (Join-Path $backup $name)}
  Copy-Item -LiteralPath $from -Destination $to -Force
  if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw 'Source integrity mismatch.'}
 }
 Copy-Item -LiteralPath (Join-Path $source 'CornGrid-Node-Agent.zip') -Destination (Join-Path $target 'CornGrid-Node-Agent.zip') -Force
 foreach($archive in @('CornGrid-Node-Agent-Linux.tar.gz','CornGrid-Node-Agent-Linux.tar.gz.sha256')){
  Copy-Item -LiteralPath (Join-Path $source $archive) -Destination (Join-Path $target $archive) -Force
 }
 foreach($relative in @('TUTORIAL SETUP NODE.MD','Corngrid-web\docs\NODE_AUTO_UPDATES.md','Corngrid-web\docs\VPS_NODE_INSTALLATION.md','Corngrid-web\docs\VPS_NODE_INSTALLATION_WINDOWS.md','Corngrid-web\docs\VPS_NODE_INSTALLATION_LINUX.md','Corngrid-web\docs\WINDOWS_AGENT_SETUP.md')){
  $to=Join-Path $target $relative
  if(Test-Path -LiteralPath $to){$saved=Join-Path $backup $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath $to -Destination $saved}
  Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $to -Force
 }
 # Publish marker LAST. The already-running backend detects this automatically.
 & (Join-Path $source 'marketing\sync-node-release-review-files.ps1')
 Copy-Item -LiteralPath (Join-Path $source 'Corngrid-web\agent\RELEASE.json') -Destination (Join-Path $target 'Corngrid-web\agent\RELEASE.json') -Force
 $report.phase='deployed-awaiting-publisher';$report.releaseId=$manifest.id;$report.version=$manifest.version;$report.backup=$backup
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message;[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress));throw}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress))
