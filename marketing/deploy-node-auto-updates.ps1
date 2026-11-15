$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'node-auto-update-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Elevated deployment failed. Inspect the deployment result.'};exit
}
$result=[ordered]@{phase='starting';hostName=[string]$env:COMPUTERNAME;agentsStopped=$false}
function Report {[IO.File]::WriteAllText($out,($result|ConvertTo-Json -Depth 6 -Compress))}
try{
 if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
 $source=Split-Path -Parent $PSScriptRoot;$target='C:\Website\Website';$backend=Join-Path $target 'Corngrid-web'
 $manifest=Get-Content -LiteralPath (Join-Path $source 'Corngrid-web\agent\RELEASE.json') -Raw|ConvertFrom-Json
 $runtime='C:\ProgramData\CornGrid\NodeUpdates'
 New-Item -ItemType Directory -Path $runtime -Force|Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & icacls.exe $runtime '/inheritance:r' '/grant:r' ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to protect signing storage.'}
 $backup=Join-Path $runtime ('deployment-before-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'));New-Item -ItemType Directory -Path $backup|Out-Null
 $files=@('Corngrid-web\server.js','Corngrid-web\sandbox\index.js','Corngrid-web\sandbox\sandbox-node-api.js','Corngrid-web\sandbox\sandbox-admin-api.js','Corngrid-web\sandbox\node-updates.js',
  'Corngrid-web\scripts\publish-node-release.js','Corngrid-web\scripts\build-agent-manifest.js','Corngrid-web\scripts\build-node-agent.ps1',
  'Corngrid-web\docs\NODE_AUTO_UPDATES.md','Corngrid-web\docs\VPS_NODE_INSTALLATION.md','Corngrid-web\docs\WINDOWS_AGENT_SETUP.md','Corngrid-web\.env.example','CornGrid-Node-Agent.zip')
 foreach($file in $manifest.files){if($file.name -notmatch '^[a-z][a-z0-9.-]+$' -or $file.name -eq 'agent-config.json'){throw 'Invalid source file.'};$files+=('Corngrid-web\agent\'+$file.name)}
 $files+=@('Corngrid-web\agent\agent-launcher.js','Corngrid-web\agent\install-service.ps1','Corngrid-web\agent\uninstall-service.ps1','Corngrid-web\agent\agent-config.example.json')
 foreach($relative in $files){
  $from=[IO.Path]::GetFullPath((Join-Path $source $relative));$to=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $from.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  if(Test-Path -LiteralPath $to){$saved=Join-Path $backup $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath $to -Destination $saved}
  New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force|Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Force
  if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw 'Deployed file integrity mismatch.'}
 }
 # Marker is copied only after every source file has reached the server.
 Copy-Item -LiteralPath (Join-Path $source 'Corngrid-web\agent\RELEASE.json') -Destination (Join-Path $backend 'agent\RELEASE.json') -Force
 $envFile=Join-Path $backend '.env';Copy-Item -LiteralPath $envFile -Destination (Join-Path $backup 'backend-before.env')
 $text=[IO.File]::ReadAllText($envFile)
 foreach($setting in @(@{name='SANDBOX_NODE_UPDATE_DIR';value=$runtime},@{name='SANDBOX_NODE_AUTO_UPDATE';value='true'})){
  $line=$setting.name+'='+$setting.value;$pattern='(?m)^'+$setting.name+'=.*$'
  if([regex]::IsMatch($text,$pattern)){$text=[regex]::Replace($text,$pattern,$line)}else{$text+="`r`n"+$line+"`r`n"}
 }
 [IO.File]::WriteAllText($envFile,$text,[Text.UTF8Encoding]::new($false))
 $env:SANDBOX_NODE_UPDATE_DIR=$runtime;$env:CORNGRID_RELEASE_SOURCE=Join-Path $backend 'agent'
 $result.phase='publishing';$result.backup=$backup;Report
 $nodeExe='C:\Program Files\nodejs\node.exe';$log=Join-Path $runtime 'initial-publish.log'
 $ErrorActionPreference='Continue';& $nodeExe (Join-Path $backend 'scripts\publish-node-release.js') *> $log;$publishExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($publishExit -ne 0){throw 'Initial signed release publication failed.'}
 $channel=Get-Content -LiteralPath (Join-Path $runtime 'channel.json') -Raw|ConvertFrom-Json
 if($channel.release.id -ne $manifest.id){throw 'Published release does not match the deployment manifest.'}
 $result.phase='restarting-website';$result.release=$channel.release;Report
 Restart-Service -Name 'CornGridWeb'
 $ready=$false;foreach($attempt in 1..25){try{$health=Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3;if($health.status -in @('ok','ready')){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Website readiness was not confirmed.'}
 $result.phase='complete';$result.deployedFiles=$files.Count+1;$result.websiteService=[string](Get-Service CornGridWeb).Status;$result.privateSigningStorage=$runtime
}catch{$result.phase='failed';$result.error=[string]$_.Exception.Message;Report;throw}
Report
