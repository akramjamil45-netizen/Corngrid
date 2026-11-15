param([ValidateSet('Baseline','Final')][string]$Mode='Final')
$ErrorActionPreference='Stop'
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
& (Join-Path $workspace 'marketing\verify-node-auto-update.ps1') -AgentDir 'C:\CornGrid\agent' -ExpectedHost VPS80481 -Mode $Mode
