param([ValidateSet('Prepare','Finish')][string]$Phase='Prepare')
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong VPS.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
& (Join-Path $workspace 'marketing\bootstrap-node-auto-update.ps1') -Phase $Phase -AgentDir 'C:\CornGrid\agent' -SourceAgentDir (Join-Path $workspace 'Corngrid-web\agent') -ExpectedHost VPS80481 -ExpectedNodeUid 'node_1677e8779f05aa567b'
