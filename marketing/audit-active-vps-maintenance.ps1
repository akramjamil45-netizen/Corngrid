$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258' -or $env:USERNAME -ne 'Administrator'){throw 'Unexpected VPS/account. No maintenance performed.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Unexpected node identity.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-maintenance-audit-result.json'
$r=[ordered]@{hostname=$env:COMPUTERNAME;at=[DateTime]::UtcNow.ToString('o');phase='starting';readOnly=$true}
function Save-Report {[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 8 -Compress))}
function Measure-Folder([string]$root,[int]$seconds=4){
 if(-not(Test-Path -LiteralPath $root -PathType Container)){return @{path=$root;mb=0;exists=$false}}
 $resolved=[IO.Path]::GetFullPath($root);$pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($resolved);$bytes=0L;$count=0;$errors=0;$deadline=[DateTime]::UtcNow.AddSeconds($seconds)
 while($pending.Count -and [DateTime]::UtcNow -lt $deadline){$directory=$pending.Pop();try{foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)){
  if([DateTime]::UtcNow -ge $deadline){$pending.Push($directory);break}
  try{$attributes=[IO.File]::GetAttributes($entry);if($attributes -band [IO.FileAttributes]::ReparsePoint){continue};if($attributes -band [IO.FileAttributes]::Directory){$pending.Push($entry)}else{$bytes+=([IO.FileInfo]$entry).Length;$count++}}catch{$errors++}
 }}catch{$errors++}}
 return @{path=$resolved;mb=[math]::Round($bytes/1MB,1);files=$count;partial=($pending.Count -gt 0);unreadable=$errors;exists=$true}
}
try{
 $os=Get-CimInstance Win32_OperatingSystem;$system=Get-CimInstance Win32_ComputerSystem
 $r.os=$os.Caption;$r.ramMb=[math]::Round($system.TotalPhysicalMemory/1MB);$r.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);$r.bootedAt=$os.LastBootUpTime.ToUniversalTime().ToString('o')
 $r.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object{@{drive=$_.DeviceID;totalMb=[math]::Round($_.Size/1MB);freeMb=[math]::Round($_.FreeSpace/1MB)}})
 $r.processes=@(Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 30|ForEach-Object{@{name=$_.ProcessName;pid=$_.Id;workingSetMb=[math]::Round($_.WorkingSet64/1MB);privateMb=[math]::Round($_.PrivateMemorySize64/1MB);path=$_.Path}})
 $r.programs=@();foreach($registry in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')){foreach($p in Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName}){$r.programs+=@{name=$p.DisplayName;version=$p.DisplayVersion;publisher=$p.Publisher;location=$p.InstallLocation;sizeKb=$p.EstimatedSize;uninstall=$p.UninstallString;quiet=$p.QuietUninstallString}}}
 $r.services=@(Get-CimInstance Win32_Service|Where-Object{$_.State -eq 'Running' -or $_.StartMode -eq 'Auto'}|ForEach-Object{@{name=$_.Name;state=$_.State;startMode=$_.StartMode;pid=$_.ProcessId}})
 $r.tasks=@(Get-ScheduledTask|Where-Object{$_.TaskPath -notlike '\Microsoft\*'}|ForEach-Object{@{name=$_.TaskName;state=[string]$_.State;executable=@($_.Actions|ForEach-Object{$_.Execute})}})
 $r.rootFiles=@(Get-ChildItem -LiteralPath 'C:\' -File -Force -ErrorAction SilentlyContinue|ForEach-Object{@{name=$_.Name;mb=[math]::Round($_.Length/1MB,1)}})
 $r.pageFiles=@(Get-CimInstance Win32_PageFileUsage|Select-Object Name,AllocatedBaseSize,CurrentUsage,PeakUsage)
 $r.terminals=@(Get-Process terminal64,terminal -ErrorAction SilentlyContinue|ForEach-Object{@{pid=$_.Id;name=$_.ProcessName;path=$_.Path;mb=[math]::Round($_.WorkingSet64/1MB)}})
 $r.startup=@(Get-CimInstance Win32_StartupCommand|Select-Object Name,Location)
 $r.phase='measuring-folders';$r.folders=@();Save-Report
 foreach($root in @('C:\Windows\Temp','C:\Windows\SoftwareDistribution\Download','C:\Windows\Logs\CBS','C:\Windows\Logs\DISM','C:\Windows\Minidump','C:\Windows\WinSxS','C:\Windows\Installer','C:\ProgramData\Microsoft\Windows\WER','C:\Users\Administrator\AppData\Local\Temp','C:\Users\Administrator\AppData\Local\pip\Cache','C:\Users\Administrator\AppData\Local\npm-cache','C:\Users\Administrator\AppData\Local\Google\Chrome\User Data','C:\Users\Administrator\Downloads','C:\$Recycle.Bin','C:\CornGrid')){$r.folders+=,(Measure-Folder $root);Save-Report}
 $r.programFolders=@();foreach($root in @('C:\Program Files','C:\Program Files (x86)')){foreach($entry in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue){$r.programFolders+=,(Measure-Folder $entry.FullName 2);Save-Report}}
 $r.downloads=@(Get-ChildItem -LiteralPath 'C:\Users\Administrator\Downloads' -File -ErrorAction SilentlyContinue|Sort-Object Length -Descending|Select-Object -First 20|ForEach-Object{@{name=$_.Name;mb=[math]::Round($_.Length/1MB,1)}})
 $r.phase='complete';$r.completedAt=[DateTime]::UtcNow.ToString('o')
}catch{$r.phase='failed';$r.error=$_.Exception.Message}
Save-Report
