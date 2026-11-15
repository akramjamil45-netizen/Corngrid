$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-prepare-result.json'
$report=[ordered]@{phase='starting';host=$env:COMPUTERNAME;removedCacheMb=0}
function Save {[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 5 -Compress))}
function Free-Mb {[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)}
$states=@()
try{
 $report.diskBeforeMb=Free-Mb;$report.originalTerminalPids=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id);Save
 if(Get-Process TiWorker,TrustedInstaller -ErrorAction SilentlyContinue){throw 'Windows servicing is active. Wait for it to finish before clearing update downloads.'}
 foreach($name in @('wuauserv','BITS')){$service=Get-Service $name -ErrorAction SilentlyContinue;if($service){$states+=@{name=$name;running=$service.Status -eq 'Running'};if($service.Status -eq 'Running'){Stop-Service $name -ErrorAction Stop}}}
 $report.phase='clearing-regenerable-update-downloads';Save
 $cache='C:\Windows\SoftwareDistribution\Download';$root=[IO.Path]::GetFullPath($cache).TrimEnd('\')
 if($root -ne 'C:\Windows\SoftwareDistribution\Download'){throw 'Unsafe cache path.'}
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($root);$bytes=0L
 while($pending.Count){$dir=$pending.Pop();if(-not(Test-Path -LiteralPath $dir)){continue};if(([IO.File]::GetAttributes($dir)) -band [IO.FileAttributes]::ReparsePoint){continue}
  foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($dir)){
   $path=[IO.Path]::GetFullPath($entry);if(-not $path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache entry.'}
   $attr=[IO.File]::GetAttributes($path);if($attr -band [IO.FileAttributes]::ReparsePoint){continue}
   if($attr -band [IO.FileAttributes]::Directory){$pending.Push($path)}else{try{$length=([IO.FileInfo]$path).Length;Remove-Item -LiteralPath $path -Force;$bytes+=$length}catch{}}
  }
 }
 $report.removedCacheMb=[math]::Round($bytes/1MB);$report.diskAfterMb=Free-Mb
 if($report.diskAfterMb -lt 500){throw 'Insufficient space remains for runtime installation.'}
 $report.phase='staging-agent';Save
 if(Test-Path -LiteralPath 'C:\CornGrid'){throw 'Existing CornGrid installation requires inspection.'}
 New-Item -ItemType Directory -Path 'C:\CornGrid'|Out-Null
 Expand-Archive -LiteralPath (Join-Path $workspace 'CornGrid-Node-Agent.zip') -DestinationPath 'C:\CornGrid'
 foreach($folder in @('MT5','Users','AgentData','BrokerCaches')){New-Item -ItemType Directory -Path ('C:\CornGrid\Sandbox\'+$folder) -Force|Out-Null}
 $report.phase='agent-files-staged';$report.diskAfterMb=Free-Mb
}catch{$report.phase='blocked';$report.error=$_.Exception.Message}finally{
 foreach($state in $states){if($state.running){try{Start-Service $state.name}catch{}}}
 $report.diskAfterMb=Free-Mb;Save
}
