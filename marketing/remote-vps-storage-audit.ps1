$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong target VPS/account.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-vps-storage-audit-result.json'
$report=[ordered]@{hostname=[string]$env:COMPUTERNAME;phase='starting';readOnly=$true}
function Save-Report {[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress -Depth 8))}
function Folder-Size([string]$Path){
 $bytes=0L;$count=0;$errors=0
 if(-not(Test-Path -LiteralPath $Path -PathType Container)){return @{path=$Path;exists=$false;mb=0;files=0}}
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($Path)
 while($pending.Count){
  $directory=$pending.Pop()
  try{foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)){
   try{$attributes=[IO.File]::GetAttributes($entry);if($attributes -band [IO.FileAttributes]::ReparsePoint){continue}
    if($attributes -band [IO.FileAttributes]::Directory){$pending.Push($entry)}else{$bytes+=([IO.FileInfo]$entry).Length;$count++}
   }catch{$errors++}
  }}catch{$errors++}
 }
 return @{path=$Path;exists=$true;mb=[math]::Round($bytes/1MB,1);files=$count;unreadable=$errors}
}
try{
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong CornGrid node.'}
 $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $report.freeDiskMb=[math]::Round($disk.FreeSpace/1MB);$report.totalDiskMb=[math]::Round($disk.Size/1MB);$report.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024)
 $report.programs=@();$firefox=@()
 foreach($registry in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')){
  foreach($program in Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName}){
   $item=@{name=[string]$program.DisplayName;version=[string]$program.DisplayVersion;publisher=[string]$program.Publisher;installLocation=[string]$program.InstallLocation;estimatedSizeKb=$program.EstimatedSize}
   $report.programs+=,$item
   if($program.DisplayName -like '*Firefox*' -or $program.DisplayName -like '*Mozilla Maintenance*'){$firefox+=@{name=[string]$program.DisplayName;uninstall=[string]$program.UninstallString;quietUninstall=[string]$program.QuietUninstallString;installLocation=[string]$program.InstallLocation}}
  }
 }
 $report.firefox=$firefox
 $report.startup=@()
 foreach($location in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')){
  if(Test-Path -LiteralPath $location){$key=Get-Item -LiteralPath $location;foreach($name in $key.GetValueNames()){$report.startup+=@{location=$location;name=$name;command=[string]$key.GetValue($name)}}}
 }
 $report.startupFolders=@();foreach($directory in @([Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonStartup'))){
  if(Test-Path -LiteralPath $directory){$report.startupFolders+=@(Get-ChildItem -LiteralPath $directory -File|ForEach-Object{@{name=$_.Name;directory=$directory}})}
 }
 $report.thirdPartyTasks=@(Get-ScheduledTask|Where-Object{$_.TaskPath -notlike '\Microsoft\*'}|ForEach-Object{@{name=$_.TaskName;path=$_.TaskPath;state=[string]$_.State;execute=@($_.Actions|ForEach-Object{[string]$_.Execute})}})
 $report.services=@(Get-CimInstance Win32_Service|Where-Object{$_.StartMode -eq 'Auto' -or $_.State -eq 'Running'}|ForEach-Object{@{name=$_.Name;displayName=$_.DisplayName;state=$_.State;startMode=$_.StartMode}})
 $report.processes=@(Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 25|ForEach-Object{@{name=$_.ProcessName;id=$_.Id;mb=[math]::Round($_.WorkingSet64/1MB);path=$_.Path}})
 $report.rootFiles=@(Get-ChildItem -LiteralPath 'C:\' -File -Force -ErrorAction SilentlyContinue|ForEach-Object{@{name=$_.Name;mb=[math]::Round($_.Length/1MB,1)}})
 $report.phase='measuring-cache-folders';Save-Report
 $cachePaths=@('C:\Windows\Temp','C:\Windows\SoftwareDistribution\Download','C:\Windows\Logs\CBS','C:\Windows\Logs\DISM','C:\Windows\Minidump',
  'C:\ProgramData\Microsoft\Windows\WER','C:\Users\Administrator\AppData\Local\Temp','C:\Users\Administrator\AppData\Local\pip\Cache',
  'C:\Users\Administrator\AppData\Local\Mozilla\Firefox','C:\Users\Administrator\AppData\Roaming\Mozilla\Firefox',
  'C:\Users\Administrator\Downloads','C:\$Recycle.Bin','C:\CornGrid')
 $report.folderSizes=@();foreach($directory in $cachePaths){$report.folderSizes+=,(Folder-Size $directory);Save-Report}
 $report.programFolderSizes=@();foreach($root in @('C:\Program Files','C:\Program Files (x86)')){
  foreach($entry in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue){$report.programFolderSizes+=,(Folder-Size $entry.FullName)}
 }
 $report.downloads=@(Get-ChildItem -LiteralPath 'C:\Users\Administrator\Downloads' -File -ErrorAction SilentlyContinue|Sort-Object Length -Descending|Select-Object -First 20|ForEach-Object{@{name=$_.Name;mb=[math]::Round($_.Length/1MB,1);modified=$_.LastWriteTimeUtc.ToString('o')}})
 $report.phase='complete';Save-Report
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message;Save-Report}
