$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong node identity.'}
foreach($file in @('configure-node.ps1','recover-config.ps1')){
 $target=[IO.Path]::GetFullPath((Join-Path 'C:\CornGrid' $file))
 if((Split-Path -Parent $target) -ne 'C:\CornGrid'){throw 'Unsafe temporary helper cleanup path.'}
 if(Test-Path -LiteralPath $target -PathType Leaf){Remove-Item -LiteralPath $target -Force}
}
Copy-Item -LiteralPath (Join-Path $workspace 'Corngrid-web\docs\VPS_NODE_INSTALLATION.md') -Destination 'C:\CornGrid\VPS_NODE_INSTALLATION.md' -Force
Copy-Item -LiteralPath (Join-Path $workspace 'Corngrid-web\docs\WINDOWS_AGENT_SETUP.md') -Destination 'C:\CornGrid\WINDOWS_AGENT_SETUP.md' -Force
& (Join-Path $workspace 'marketing\remote-sandbox-postflight.ps1')
