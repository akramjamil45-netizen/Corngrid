$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Wrong node.'}
$localReport='C:\CornGrid\cleanup-result.json'
$r=[ordered]@{hostname=$env:COMPUTERNAME;phase='starting';actions=@();skipped=@();cleanup=@()}
function Save {[IO.File]::WriteAllText($localReport,($r|ConvertTo-Json -Depth 7 -Compress))}
$r.diskBeforeMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
$r.mt5PidsBefore=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
$cacheRoots=@('C:\Windows\Temp','C:\Users\Administrator\AppData\Local\Temp','C:\Users\Administrator\AppData\Local\pip\Cache','C:\Users\Administrator\AppData\Local\Mozilla\Firefox','C:\ProgramData\Microsoft\Windows\WER')
function Clear-Cache([string]$Root,[DateTime]$Cutoff){
 $absolute=[IO.Path]::GetFullPath($Root).TrimEnd('\')
 if($cacheRoots -notcontains $absolute){throw 'Cache root is not allowlisted.'}
 $stats=@{path=$absolute;deletedMb=0;deletedFiles=0;skipped=0};$bytes=0L
 if(-not(Test-Path -LiteralPath $absolute)){return $stats}
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($absolute)
 while($pending.Count){
  $directory=$pending.Pop();$full=[IO.Path]::GetFullPath($directory)
  if($full -ne $absolute -and -not $full.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache traversal.'}
  if(([IO.File]::GetAttributes($full)) -band [IO.FileAttributes]::ReparsePoint){continue}
  try{$entries=@([IO.Directory]::EnumerateFileSystemEntries($full))}catch{continue}
  foreach($entry in $entries){try{
   $path=[IO.Path]::GetFullPath($entry)
   if(-not $path.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache path.'}
   $attrs=[IO.File]::GetAttributes($path);if($attrs -band [IO.FileAttributes]::ReparsePoint){continue}
   if($attrs -band [IO.FileAttributes]::Directory){$pending.Push($path);continue}
   $file=[IO.FileInfo]$path;if($file.LastWriteTimeUtc -ge $Cutoff){continue}
   $length=$file.Length;Remove-Item -LiteralPath $path -Force;$bytes+=$length;$stats.deletedFiles++
  }catch{$stats.skipped++}}
 }
 $stats.deletedMb=[math]::Round($bytes/1MB,1);return $stats
}
function Uninstall-Mozilla([string]$Executable){
 $allowed=@('C:\Program Files\Mozilla Firefox\uninstall\helper.exe','C:\Program Files (x86)\Mozilla Maintenance Service\uninstall.exe')
 if($allowed -notcontains [IO.Path]::GetFullPath($Executable)){throw 'Unexpected uninstaller path.'}
 if(-not(Test-Path -LiteralPath $Executable)){return}
 $sig=Get-AuthenticodeSignature -LiteralPath $Executable
 if(-not(Test-Path -LiteralPath $Executable)){return}
 if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Mozilla'){throw 'Uninstaller signature mismatch.'}
 $p=Start-Process -FilePath $Executable -ArgumentList '/S' -WindowStyle Hidden -PassThru
 if(-not $p.WaitForExit(90000)){throw 'Mozilla uninstaller timeout; inspect before retry.'}
 $r.actions+=@{action='uninstall';path=$Executable;exitCode=$p.ExitCode};Save
}
try{
 $r.phase='uninstalling-firefox';Save
 foreach($p in Get-Process firefox -ErrorAction SilentlyContinue){
  if($p.Path -and $p.Path.StartsWith('C:\Program Files\Mozilla Firefox\',[StringComparison]::OrdinalIgnoreCase)){
   [void]$p.CloseMainWindow();if(-not $p.WaitForExit(10000)){Stop-Process -Id $p.Id -Force}
  }
 }
 Uninstall-Mozilla 'C:\Program Files\Mozilla Firefox\uninstall\helper.exe'
 try{Uninstall-Mozilla 'C:\Program Files (x86)\Mozilla Maintenance Service\uninstall.exe'}catch{$r.skipped+=('Mozilla Maintenance uninstaller: '+$_.Exception.Message)}
 $deadline=(Get-Date).AddSeconds(30)
 while((Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe') -and (Get-Date) -lt $deadline){Start-Sleep -Seconds 1}
 $r.firefoxRemoved=-not(Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe')
 if(-not $r.firefoxRemoved){throw 'Firefox remains installed.'}
 $backup='C:\CornGrid\Sandbox\AgentData\Maintenance-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 $services=@();foreach($name in @('DiagTrack','SysMain','WSearch','Spooler')){
  $s=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
  if($s){$services+=@{name=$s.Name;startMode=$s.StartMode;state=$s.State}}
 }
 $policies=@();foreach($setting in @(@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='StartupBoostEnabled'},@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='BackgroundModeEnabled'},@{key='HKLM:\SOFTWARE\Policies\Google\Chrome';name='BackgroundModeEnabled'})){
  $key=Get-Item -LiteralPath $setting.key -ErrorAction SilentlyContinue
  $exists=$key -and ($key.GetValueNames() -contains $setting.name)
  $policies+=@{key=$setting.key;name=$setting.name;existed=[bool]$exists;value=if($exists){$key.GetValue($setting.name)}else{$null}}
 }
 [IO.File]::WriteAllText((Join-Path $backup 'settings-before.json'),(@{services=$services;policies=$policies}|ConvertTo-Json -Depth 6))
 $r.settingsBackup=$backup;$r.phase='optional-background-services';Save
 foreach($saved in $services){
  $s=Get-Service -Name $saved.name
  if(@($s.DependentServices|Where-Object{$_.Status -eq 'Running'}).Count){$r.skipped+=($s.Name+': active dependent service');continue}
  if($s.Name -eq 'Spooler' -and @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue).Count){$r.skipped+='Spooler: print jobs pending';continue}
  Set-Service -Name $s.Name -StartupType Disabled
  if($s.Status -ne 'Stopped'){Stop-Service -Name $s.Name}
  $r.actions+=@{action='disabled-service';name=$s.Name}
 }
 foreach($p in $policies){
  if(-not(Test-Path -LiteralPath $p.key)){New-Item -Path $p.key -Force|Out-Null}
  New-ItemProperty -LiteralPath $p.key -Name $p.name -PropertyType DWord -Value 0 -Force|Out-Null
  $r.actions+=@{action='disabled-browser-background';name=$p.name;key=$p.key}
 }
 $r.phase='cleaning-caches';Save
 foreach($root in $cacheRoots){
  $cutoff=if($root -like '*Mozilla*' -or $root -like '*pip\Cache'){[DateTime]::UtcNow}else{[DateTime]::UtcNow.AddDays(-2)}
  $r.cleanup+=,(Clear-Cache $root $cutoff);Save
 }
 $r.phase='complete'
}catch{$r.phase='failed';$r.error=$_.Exception.Message}
$r.mt4Removed=-not(Test-Path -LiteralPath 'C:\Program Files (x86)\RoboForex - MetaTrader 4\terminal.exe')
$r.diskAfterMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
$r.reclaimedMb=$r.diskAfterMb-$r.diskBeforeMb
$r.freeRamMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
$r.mt5Preserved=@($r.mt5PidsBefore|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count -eq $r.mt5PidsBefore.Count
$r.agentTaskState=[string](Get-ScheduledTask -TaskName CornGridSandboxManagedAgent).State
$r.checkedAt=[DateTime]::UtcNow.ToString('o');Save
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-cleanup-result.json',($r|ConvertTo-Json -Depth 7 -Compress))
