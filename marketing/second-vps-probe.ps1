$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -eq 'WINSLET'){throw 'Probe must run inside the second VPS.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-probe-result.json'
$report=[ordered]@{phase='starting';hostname=[string]$env:COMPUTERNAME;user=[string]$env:USERNAME;readOnly=$true}
function Save-Report {[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 7 -Compress))}
try{
 $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";$cpu=Get-CimInstance Win32_ComputerSystem
 $report.os=[string]$os.Caption;$report.osVersion=[string]$os.Version;$report.arch=[string]$os.OSArchitecture
 $report.ramMb=[math]::Round($os.TotalVisibleMemorySize/1024);$report.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);$report.logicalCpu=$cpu.NumberOfLogicalProcessors
 $report.diskTotalMb=[math]::Round($disk.Size/1MB);$report.diskFreeMb=[math]::Round($disk.FreeSpace/1MB)
 $report.redirectedSourceAvailable=Test-Path -LiteralPath (Join-Path $workspace 'CornGrid-Node-Agent.zip')
 $report.existingCornGrid=Test-Path -LiteralPath 'C:\CornGrid'
 if(Test-Path -LiteralPath 'C:\CornGrid\agent\agent-config.json'){
  $existing=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
  $report.existingNodeUid=[string]$existing.nodeUid;$report.existingBackend=[string]$existing.backendUrl
 }
 $report.cornGridTasks=@(Get-ScheduledTask|Where-Object{$_.TaskName -like '*CornGrid*'}|ForEach-Object{@{name=$_.TaskName;state=[string]$_.State;user=[string]$_.Principal.UserId}})
 $report.terminals=@(Get-Process terminal64,terminal -ErrorAction SilentlyContinue|ForEach-Object{@{pid=$_.Id;path=$_.Path;sessionId=$_.SessionId;memoryMb=[math]::Round($_.WorkingSet64/1MB)}})
 $node=Get-Command node.exe -ErrorAction SilentlyContinue
 $report.node=if($node){@{path=$node.Source;version=[string](& $node.Source --version)}}else{$null}
 $candidates=@();foreach($root in @('C:\Program Files','C:\Users\Administrator\AppData\Local\Programs\Python')){
  if(Test-Path -LiteralPath $root){foreach($directory in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue|Where-Object{$_.Name -like 'Python*'}){$candidate=Join-Path $directory.FullName 'python.exe';if(Test-Path -LiteralPath $candidate){$candidates+=$candidate}}}
 }
 $report.python=@();foreach($candidate in $candidates){$report.python+=@{path=$candidate;version=[string](& $candidate --version)}}
 $report.mt5Installations=@();foreach($root in @('C:\Program Files','C:\Program Files (x86)')){
  foreach($directory in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue){$terminal=Join-Path $directory.FullName 'terminal64.exe';if(Test-Path -LiteralPath $terminal){$info=Get-Item -LiteralPath $terminal;$signature=Get-AuthenticodeSignature -LiteralPath $terminal;$report.mt5Installations+=@{directory=$directory.FullName;fileVersion=$info.VersionInfo.FileVersion;signature=[string]$signature.Status}}}
 }
 $report.webRequestProfiles=@();$profiles=Join-Path $env:APPDATA 'MetaQuotes\Terminal'
 foreach($profile in Get-ChildItem -LiteralPath $profiles -Directory -ErrorAction SilentlyContinue){
  $origin=Join-Path $profile.FullName 'origin.txt';$ini=Join-Path $profile.FullName 'config\common.ini';if(-not(Test-Path -LiteralPath $origin) -or -not(Test-Path -LiteralPath $ini)){continue}
  $bytes=[IO.File]::ReadAllBytes($ini);$encoding=if($bytes.Length -gt 1 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254){[Text.Encoding]::Unicode}else{[Text.Encoding]::UTF8}
  $text=$encoding.GetString($bytes);$experts=[regex]::Match($text,'(?s)\[Experts\](.*?)(?=\r?\n\[|$)').Groups[1].Value
  $report.webRequestProfiles+=@{directory=$profile.FullName;programOrigin=([IO.File]::ReadAllText($origin)).Trim();hasAllowedUrls=[bool]($experts -match '(?m)^WebRequestUrl=.+')}
 }
 $report.phase='complete';Save-Report
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message;try{Save-Report}catch{};throw}
