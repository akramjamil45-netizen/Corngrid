$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Storage audit must run only on VPS81258.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-storage-result.json'
$report=[ordered]@{phase='starting';readOnly=$true;hostName=$env:COMPUTERNAME;folders=@()}
function Save-Report {[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 5 -Compress))}
function Measure-Folder([string]$directory){
 $bytes=0L;$oldBytes=0L;$files=0;$errors=0;$deadline=(Get-Date).AddSeconds(15)
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($directory)
 while($pending.Count -and (Get-Date) -lt $deadline){
  $current=$pending.Pop()
  try{foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($current)){
   try{
    $attrs=[IO.File]::GetAttributes($entry);if($attrs -band [IO.FileAttributes]::ReparsePoint){continue}
    if($attrs -band [IO.FileAttributes]::Directory){$pending.Push($entry)}else{$item=[IO.FileInfo]$entry;$bytes+=$item.Length;$files++;if($item.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)){$oldBytes+=$item.Length}}
   }catch{$errors++}
  }}catch{$errors++}
 }
 return @{path=$directory;mb=[math]::Round($bytes/1MB,1);olderThanSevenDaysMb=[math]::Round($oldBytes/1MB,1);files=$files;unreadable=$errors;partial=($pending.Count -gt 0)}
}
try{
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";$os=Get-CimInstance Win32_OperatingSystem
 $report.freeDiskMb=[math]::Round($disk.FreeSpace/1MB);$report.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024)
 $report.phase='measuring';Save-Report
 foreach($directory in @('C:\Windows\Temp','C:\Windows\SoftwareDistribution\Download','C:\Windows\Logs\CBS','C:\Windows\Logs\DISM','C:\ProgramData\Microsoft\Windows\WER','C:\Users\Administrator\AppData\Local\Temp','C:\Users\Administrator\AppData\Local\Mozilla\Firefox','C:\$Recycle.Bin')){
  if(Test-Path -LiteralPath $directory){$report.folders+=,(Measure-Folder $directory);Save-Report}
 }
 $report.phase='complete';Save-Report
}catch{$report.phase='failed';$report.error=$_.Exception.Message;Save-Report;throw}
