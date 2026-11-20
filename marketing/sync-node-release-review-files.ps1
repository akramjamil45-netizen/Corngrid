param([string]$TargetRoot='C:\Website\Website')
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
if([IO.Path]::GetFullPath($TargetRoot).TrimEnd('\') -ne 'C:\Website\Website'){throw 'Unexpected deployment root.'}
# Public bootstrap/build/test sources make the deployment checkout reviewable
# and rebuildable. Copying these files does not replace running task processes,
# scheduled-task registrations, private configs or terminal data.
$files=@(
 'Corngrid-web\agent\agent-launcher.js',
 'Corngrid-web\agent\install-service.ps1',
 'Corngrid-web\agent\uninstall-service.ps1',
 'Corngrid-web\agent\install-service.sh',
 'Corngrid-web\agent\uninstall-service.sh',
 'Corngrid-web\agent\agent-config.linux.example.json',
 'Corngrid-web\scripts\build-agent-manifest.js',
 'Corngrid-web\scripts\build-node-agent.ps1',
 'Corngrid-web\scripts\build-linux-node-agent.js',
 'Corngrid-web\scripts\publish-node-release.js',
 'Corngrid-web\test\agent-recovery.test.js',
 'Corngrid-web\test\broker-deploy.test.js',
 'Corngrid-web\test\broker-resolution.test.js',
 'Corngrid-web\test\broker_probe_test.py',
 'Corngrid-web\test\helpers\terminal-detachment-worker.cjs',
 'Corngrid-web\test\ipc-probe.test.js',
 'Corngrid-web\test\linux-agent.test.js',
 'Corngrid-web\test\mt5-startup.test.js',
 'Corngrid-web\test\node-command-execution.test.js',
 'Corngrid-web\test\node-installation.test.js',
 'Corngrid-web\test\node-updates.test.js',
 'marketing\publish-node-update.ps1',
 'marketing\sync-node-release-review-files.ps1',
 'marketing\verify-sandbox-node-release.cjs'
)
$backup=Join-Path 'C:\ProgramData\CornGrid\NodeUpdates' ('review-source-before-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
foreach($relative in $files){
 $from=Join-Path $sourceRoot $relative
 if(-not(Test-Path -LiteralPath $from -PathType Leaf)){throw ('Missing review source: '+$relative)}
}
foreach($relative in $files){
 $from=Join-Path $sourceRoot $relative;$to=Join-Path $TargetRoot $relative;$saved=Join-Path $backup $relative
 if(Test-Path -LiteralPath $to){New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath $to -Destination $saved}
 New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force|Out-Null
 Copy-Item -LiteralPath $from -Destination $to -Force
 if((Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw ('Review source hash mismatch: '+$relative)}
}
Write-Output ('Synchronized '+$files.Count+' public review sources; no service or terminal commands were sent.')
