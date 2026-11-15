$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Wrong node.'}
$r=[ordered]@{hostname=$env:COMPUTERNAME;phase='audit';programs=@();services=@();processes=@();folders=@()}
$os=Get-CimInstance Win32_OperatingSystem
$r.freeRamMb=[math]::Round($os.FreePhysicalMemory/1024)
$r.freeDiskMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
foreach($registry in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')){
 foreach($p in Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName}){
  $r.programs+=@{name=$p.DisplayName;location=$p.InstallLocation;uninstall=$p.UninstallString;quiet=$p.QuietUninstallString;publisher=$p.Publisher}
 }
}
$r.processes=@(Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 25|ForEach-Object{@{pid=$_.Id;name=$_.ProcessName;mb=[math]::Round($_.WorkingSet64/1MB);path=$_.Path}})
$r.services=@(Get-CimInstance Win32_Service|Where-Object{$_.StartMode -eq 'Auto' -or $_.State -eq 'Running'}|ForEach-Object{@{name=$_.Name;state=$_.State;startMode=$_.StartMode}})
$r.tasks=@(Get-ScheduledTask|Where-Object{$_.TaskPath -notlike '\Microsoft\*'}|ForEach-Object{@{name=$_.TaskName;state=[string]$_.State;execute=@($_.Actions|ForEach-Object{$_.Execute})}})
$r.mt4=@();foreach($root in @('C:\Program Files','C:\Program Files (x86)')){
 foreach($d in Get-ChildItem -LiteralPath $root -Directory){
  if(Test-Path -LiteralPath (Join-Path $d.FullName 'terminal.exe')){
   $r.mt4+=@{path=$d.FullName;uninstaller=(Test-Path -LiteralPath (Join-Path $d.FullName 'uninstall.exe'));signature=[string](Get-AuthenticodeSignature -LiteralPath (Join-Path $d.FullName 'terminal.exe')).Status}
  }
 }
}
foreach($root in @('C:\Windows\Temp','C:\Users\Administrator\AppData\Local\Temp','C:\Windows\SoftwareDistribution\Download','C:\Users\Administrator\AppData\Local\Mozilla\Firefox','C:\Users\Administrator\AppData\Local\pip\Cache','C:\ProgramData\Microsoft\Windows\WER')){
 $bytes=0L;$pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($root);$deadline=(Get-Date).AddSeconds(5)
 while($pending.Count -and (Get-Date) -lt $deadline){$d=$pending.Pop();try{foreach($e in [IO.Directory]::EnumerateFileSystemEntries($d)){
  $a=[IO.File]::GetAttributes($e);if($a -band [IO.FileAttributes]::ReparsePoint){continue};if($a -band [IO.FileAttributes]::Directory){$pending.Push($e)}else{$bytes+=([IO.FileInfo]$e).Length}
 }}catch{}}
 $r.folders+=@{path=$root;mb=[math]::Round($bytes/1MB);partial=($pending.Count -gt 0)}
}
$r.downloads=@(Get-ChildItem -LiteralPath 'C:\Users\Administrator\Downloads' -File -ErrorAction SilentlyContinue|Select-Object Name,Length)
$r.phase='complete';$json=$r|ConvertTo-Json -Depth 7 -Compress
[IO.File]::WriteAllText('C:\CornGrid\cleanup-audit.json',$json)
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-cleanup-audit.json',$json)
