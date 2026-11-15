param([switch]$Resume)
$ErrorActionPreference='Stop'
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$resultFile=Join-Path $workspace 'marketing\remote-sandbox-stage-result.json'
$result=[ordered]@{phase='starting';hostname=$env:COMPUTERNAME;agentInstalled=$false;agentStarted=$false;hostingEnabled=$false}
function Save-Result { [IO.File]::WriteAllText($resultFile,($result|ConvertTo-Json -Compress -Depth 6)) }
try{
 if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Unexpected target Windows host/account.'}
 Save-Result
 $root='C:\CornGrid'
 if(Test-Path -LiteralPath $root){
  if(-not $Resume){throw 'C:\CornGrid already exists; refusing to replace a prior installation.'}
  $package=Get-Content -LiteralPath (Join-Path $root 'agent\package.json') -Raw | ConvertFrom-Json
  if($package.name -ne 'corngrid-sandbox-agent' -or (Test-Path -LiteralPath (Join-Path $root 'agent\agent-config.json')) -or @(Get-ChildItem -LiteralPath (Join-Path $root 'Sandbox\Users') -Force).Count){throw 'The existing installation cannot be safely resumed.'}
 }
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 if($disk.FreeSpace -lt 400MB){throw 'Insufficient disk space even for agent preparation.'}
 $node='C:\Program Files\nodejs\node.exe'
 if(-not(Test-Path -LiteralPath $node)){throw 'The installed Node.js runtime was not found.'}
 if(-not $Resume){
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $workspace 'CornGrid-Node-Agent.zip'))
 try{
  foreach($entry in $zip.Entries){$destination=[IO.Path]::GetFullPath((Join-Path $root $entry.FullName));if(-not $destination.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe archive entry.'}}
 }finally{$zip.Dispose()}
 New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
 Expand-Archive -LiteralPath (Join-Path $workspace 'CornGrid-Node-Agent.zip') -DestinationPath $root -ErrorAction Stop
 foreach($folder in @('MT5','Users','AgentData','BrokerCaches')){New-Item -ItemType Directory -Path (Join-Path $root ('Sandbox\'+$folder)) -Force | Out-Null}
 }
 $agent=Join-Path $root 'agent'
 $env:PATH='C:\Program Files\nodejs;'+$env:PATH
 $result.phase='installing-agent-dependency';Save-Result
 Push-Location -LiteralPath $agent
 try{$ErrorActionPreference='Continue';& 'C:\Program Files\nodejs\npm.cmd' ci --omit=dev --no-audit --no-fund --cache (Join-Path $root 'InstallCache') *> (Join-Path $root 'agent-npm-install.log');$installExit=$LASTEXITCODE;$ErrorActionPreference='Stop';if($installExit -ne 0){throw 'Agent dependency installation failed; see agent-npm-install.log on the VPS.'}}
 finally{Pop-Location}
 $result.agentInstalled=$true;$result.phase='checking-existing-python';Save-Result
 $python='C:\Program Files\Python312\python.exe'
 $pythonProbe="import sys,struct,json,importlib.util;print(json.dumps(dict(version=sys.version.split()[0],bits=struct.calcsize('P')*8,metatrader5Installed=importlib.util.find_spec('MetaTrader5') is not None,numpyInstalled=importlib.util.find_spec('numpy') is not None)))"
 $pythonInfo=& $python -c $pythonProbe
 if($LASTEXITCODE -eq 0){$result.python=$pythonInfo|ConvertFrom-Json}
 $result.mt5Programs=@(Get-ChildItem -LiteralPath 'C:\Program Files\RoboForex MT5 Terminal' -File | Select-Object Name,Length)
 $result.mt5ProgramSizeMb=[math]::Round((Get-ChildItem -LiteralPath 'C:\Program Files\RoboForex MT5 Terminal' -File -Recurse | Measure-Object Length -Sum).Sum/1MB)
 $result.freeDiskMb=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
 $result.phase='agent-staged-awaiting-hosting-resources';Save-Result
 Write-Output 'CornGrid agent files and WebSocket dependency are installed. No agent, task or sandbox was started.'
}catch{$result.phase='failed';$result.error=$_.Exception.Message;Save-Result;Write-Error $_}
