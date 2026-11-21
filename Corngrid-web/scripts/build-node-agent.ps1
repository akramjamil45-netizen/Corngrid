[CmdletBinding()]
param([string]$OutputPath='')
$ErrorActionPreference='Stop'
$backend=Split-Path -Parent $PSScriptRoot
$workspace=Split-Path -Parent $backend
& node.exe (Join-Path $PSScriptRoot 'build-agent-manifest.js')
if($LASTEXITCODE -ne 0){throw 'Could not build the agent deployment manifest.'}
if([string]::IsNullOrWhiteSpace($OutputPath)){$OutputPath=Join-Path $workspace 'CornGrid-Node-Agent.zip'}
$agentFiles=@('agent.js','config.js','transport.js','system-monitor.js','mt5-manager.js','mt5-startup.js',
 'proxy-protocol.js','proxy-tunnel.js','proxy-network.js','proxy-bridge-worker.js',
 'broker-resolution.js','broker-server-cache.js','broker-probe.py','ipc-probe.js','operation-queue.js','command-execution.js','resolve-broker.ps1','setup-broker-tools.ps1',
 'ea-tester.js','source-compiler.js','linux-runtime.js','check-installation.js','package.json','package-lock.json',
 'agent-config.example.json','install-service.ps1','uninstall-service.ps1',
 'auto-update.js','update-protocol.js','agent-launcher.js','RELEASE.json')
$sources=@()
foreach($name in $agentFiles){$sources+=@{Source=(Join-Path $backend "agent/$name");Name="agent/$name"}}
$sources+=@{Source=(Join-Path $workspace 'TUTORIAL SETUP NODE.MD');Name='TUTORIAL SETUP NODE.MD'}
$sources+=@{Source=(Join-Path $backend 'docs/WINDOWS_AGENT_SETUP.md');Name='WINDOWS_AGENT_SETUP.md'}
$sources+=@{Source=(Join-Path $backend 'docs/VPS_NODE_INSTALLATION.md');Name='VPS_NODE_INSTALLATION.md'}
$sources+=@{Source=(Join-Path $backend 'docs/VPS_NODE_INSTALLATION_WINDOWS.md');Name='VPS_NODE_INSTALLATION_WINDOWS.md'}
$sources+=@{Source=(Join-Path $backend 'docs/VPS_NODE_INSTALLATION_LINUX.md');Name='VPS_NODE_INSTALLATION_LINUX.md'}
$sources+=@{Source=(Join-Path $backend 'docs/PARTNER_PUBLICATION.md');Name='PARTNER_PUBLICATION.md'}
$sources+=@{Source=(Join-Path $backend 'docs/NODE_AUTO_UPDATES.md');Name='NODE_AUTO_UPDATES.md'}
foreach($file in $sources){if(-not (Test-Path -LiteralPath $file.Source -PathType Leaf)){throw "Missing package source: $($file.Name)"}}
$destination=[IO.Path]::GetFullPath($OutputPath)
$parent=Split-Path -Parent $destination
if(-not (Test-Path -LiteralPath $parent -PathType Container)){throw 'The output directory must already exist.'}
$temporary=Join-Path $parent ('.corngrid-node-'+[Guid]::NewGuid().ToString()+'.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
try{
    $zip=[IO.Compression.ZipFile]::Open($temporary,[IO.Compression.ZipArchiveMode]::Create)
    try{
        $entries=@()
        foreach($file in $sources){
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.Source,$file.Name,[IO.Compression.CompressionLevel]::Optimal)
            $entries+=@{path=$file.Name;bytes=(Get-Item -LiteralPath $file.Source).Length;sha256=(Get-FileHash -LiteralPath $file.Source -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $manifest=@{format=1;builtAtUtc=[DateTime]::UtcNow.ToString('o');agentVersion=(Get-Content -LiteralPath (Join-Path $backend 'agent/package.json') -Raw | ConvertFrom-Json).version;files=$entries}
        $entry=$zip.CreateEntry('MANIFEST.json')
        $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
        try{$writer.Write(($manifest | ConvertTo-Json -Depth 5))}finally{$writer.Dispose()}
    }finally{$zip.Dispose()}
    if(Test-Path -LiteralPath $destination){
        $backup=Join-Path ([IO.Path]::GetTempPath()) ('CornGrid-Node-Agent-before-'+[Guid]::NewGuid().ToString()+'.zip')
        Copy-Item -LiteralPath $destination -Destination $backup
        Write-Host "Previous package backed up: $backup"
    }
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    Write-Host "Built node package with $($sources.Count) files and a SHA-256 manifest: $destination"
    Write-Host 'Allowlist excludes live configuration, credentials, node_modules, logs and runtime data.'
}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
