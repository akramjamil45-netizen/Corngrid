$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong target VPS/account.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\remote-vps-storage-cleanup-result.json'
$result=[ordered]@{hostname=[string]$env:COMPUTERNAME;phase='starting';actions=@();cleanup=@();skipped=@()}
function Save-Report {[IO.File]::WriteAllText($out,($result|ConvertTo-Json -Compress -Depth 8))}
function Free-DiskMb {return [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)}
$cacheRoots=@('C:\Windows\Temp','C:\Windows\SoftwareDistribution\Download','C:\Users\Administrator\AppData\Local\Temp','C:\Users\Administrator\AppData\Local\pip\Cache')
function Clear-OldCache([string]$Root,[DateTime]$OlderThan){
 $absolute=[IO.Path]::GetFullPath($Root).TrimEnd('\')
 if($cacheRoots -notcontains $absolute){throw 'Cache path is outside the reviewed allowlist.'}
 $stats=@{path=$absolute;deletedFiles=0;deletedBytes=0L;skippedFiles=0}
 if(-not(Test-Path -LiteralPath $absolute -PathType Container)){return $stats}
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($absolute)
 while($pending.Count){
  $directory=$pending.Pop();$full=[IO.Path]::GetFullPath($directory)
  if($full -ne $absolute -and -not $full.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache traversal.'}
  if(([IO.File]::GetAttributes($directory)) -band [IO.FileAttributes]::ReparsePoint){continue}
  try{$entries=@([IO.Directory]::EnumerateFileSystemEntries($directory))}catch{continue}
  foreach($entry in $entries){try{
   $path=[IO.Path]::GetFullPath($entry)
   if(-not $path.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache entry.'}
   $attributes=[IO.File]::GetAttributes($path)
   if($attributes -band [IO.FileAttributes]::ReparsePoint){continue}
   if($attributes -band [IO.FileAttributes]::Directory){$pending.Push($path);continue}
   $file=[IO.FileInfo]$path
   if($file.LastWriteTimeUtc -ge $OlderThan){$stats.skippedFiles++;continue}
   $bytes=$file.Length;Remove-Item -LiteralPath $path -Force -ErrorAction Stop
   $stats.deletedFiles++;$stats.deletedBytes+=$bytes
  }catch{$stats.skippedFiles++}}
 }
 $stats.deletedMb=[math]::Round($stats.deletedBytes/1MB,1);$stats.Remove('deletedBytes');return $stats
}
function Mozilla-Uninstall([string]$Executable){
 $allowed=@('C:\Program Files\Mozilla Firefox\uninstall\helper.exe','C:\Program Files (x86)\Mozilla Maintenance Service\uninstall.exe')
 $path=[IO.Path]::GetFullPath($Executable)
 if($allowed -notcontains $path){throw 'Unexpected Mozilla uninstaller path.'}
 if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return}
 $signature=Get-AuthenticodeSignature -LiteralPath $path
 # Firefox's uninstaller can asynchronously remove its maintenance component.
 if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return}
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Mozilla'){throw 'Mozilla uninstaller signature verification failed.'}
 $process=Start-Process -FilePath $path -ArgumentList '/S' -WindowStyle Hidden -PassThru
 if(-not $process.WaitForExit(90000)){throw 'Mozilla uninstaller did not finish within the expected time.'}
 $result.actions+=@{action='uninstall';program=$path;exitCode=$process.ExitCode}
}
try{
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Wrong CornGrid node.'}
 $audit=Get-Content -LiteralPath (Join-Path $workspace 'marketing\remote-vps-storage-audit-result.json') -Raw|ConvertFrom-Json
 if($audit.hostname -ne $env:COMPUTERNAME -or $audit.phase -ne 'complete'){throw 'Storage audit is incomplete.'}
 $result.freeDiskMbBefore=Free-DiskMb
 $result.originalMt5Pids=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 $backup='C:\CornGrid\Sandbox\AgentData\VpsMaintenance-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 $result.settingsBackup=$backup
 $serviceBackup=@();$policyBackup=@()
 foreach($name in @('DiagTrack','SysMain')){
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'")
  if($service){$serviceBackup+=@{name=$service.Name;startMode=$service.StartMode;state=$service.State}}
 }
 foreach($policy in @(@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='StartupBoostEnabled'},@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='BackgroundModeEnabled'},@{key='HKLM:\SOFTWARE\Policies\Google\Chrome';name='BackgroundModeEnabled'})){
  $key=Get-Item -LiteralPath $policy.key -ErrorAction SilentlyContinue
  $exists=$key -and ($key.GetValueNames() -contains $policy.name)
  $policyBackup+=@{key=$policy.key;name=$policy.name;existed=[bool]$exists;value=if($exists){$key.GetValue($policy.name)}else{$null}}
 }
 [IO.File]::WriteAllText((Join-Path $backup 'settings-before.json'),(@{services=$serviceBackup;policies=$policyBackup}|ConvertTo-Json -Depth 6))
 $result.phase='uninstalling-firefox';Save-Report
 foreach($process in Get-Process firefox -ErrorAction SilentlyContinue){
  if($process.Path -and $process.Path.StartsWith('C:\Program Files\Mozilla Firefox\',[StringComparison]::OrdinalIgnoreCase)){
   [void]$process.CloseMainWindow();if(-not $process.WaitForExit(10000)){Stop-Process -Id $process.Id -Force}
  }
 }
 Mozilla-Uninstall 'C:\Program Files\Mozilla Firefox\uninstall\helper.exe'
 $deadline=(Get-Date).AddSeconds(30)
 while((Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe') -and (Get-Date) -lt $deadline){Start-Sleep -Seconds 1}
 $result.firefoxExecutableRemoved=-not(Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe')
 if(-not $result.firefoxExecutableRemoved){throw 'Firefox executable still exists after uninstall.'}
 Mozilla-Uninstall 'C:\Program Files (x86)\Mozilla Maintenance Service\uninstall.exe'
 $result.phase='disabling-optional-background-programs';Save-Report
 foreach($name in @('DiagTrack','SysMain')){
  $service=Get-Service -Name $name -ErrorAction SilentlyContinue
  if(-not $service){continue}
  if(@($service.DependentServices|Where-Object{$_.Status -eq 'Running'}).Count){$result.skipped+=($name+': running dependent service');continue}
  Set-Service -Name $name -StartupType Disabled
  if($service.Status -ne 'Stopped'){Stop-Service -Name $name -ErrorAction Stop}
  $result.actions+=@{action='disabled-service';name=$name}
 }
 foreach($policy in $policyBackup){
  if(-not(Test-Path -LiteralPath $policy.key)){New-Item -Path $policy.key -Force|Out-Null}
  New-ItemProperty -LiteralPath $policy.key -Name $policy.name -Value 0 -PropertyType DWord -Force|Out-Null
  $result.actions+=@{action='disabled-browser-background';key=$policy.key;name=$policy.name}
 }
 $result.phase='cleaning-reviewed-caches';Save-Report
 foreach($root in @('C:\Windows\Temp','C:\Users\Administrator\AppData\Local\Temp')){$result.cleanup+=,(Clear-OldCache $root ([DateTime]::UtcNow.AddDays(-2)));Save-Report}
 $result.cleanup+=,(Clear-OldCache 'C:\Users\Administrator\AppData\Local\pip\Cache' ([DateTime]::UtcNow.AddHours(-1)));Save-Report
 # Update download payloads are regenerable; preserve DataStore, component store,
 # installer cache, current servicing and recent downloads. Restore service state.
 $activeServicing=@(Get-Process TiWorker,dism,setuphost,msiexec -ErrorAction SilentlyContinue)
 $installer=Get-Service TrustedInstaller -ErrorAction SilentlyContinue
 if($activeServicing.Count -or ($installer -and $installer.Status -eq 'Running')){$result.skipped+='Windows Update download cache: servicing active'}
 else{
  $resume=@()
  try{
   foreach($name in @('wuauserv','BITS')){$service=Get-Service $name -ErrorAction SilentlyContinue;if($service -and $service.Status -ne 'Stopped'){$resume+=$name;Stop-Service -Name $name -ErrorAction Stop}}
   $result.cleanup+=,(Clear-OldCache 'C:\Windows\SoftwareDistribution\Download' ([DateTime]::UtcNow.AddDays(-7)))
  }finally{foreach($name in $resume){Start-Service -Name $name -ErrorAction Continue}}
 }
 $original='C:\Users\Administrator\Downloads\python-manager-26.3.msix'
 $duplicate='C:\Users\Administrator\Downloads\python-manager-26.3 (1).msix'
 if((Test-Path -LiteralPath $original -PathType Leaf) -and (Test-Path -LiteralPath $duplicate -PathType Leaf)){
  $resolved=[IO.Path]::GetFullPath($duplicate)
  if($resolved -ne 'C:\Users\Administrator\Downloads\python-manager-26.3 (1).msix'){throw 'Unexpected duplicate installer path.'}
  if((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $duplicate -Algorithm SHA256).Hash){
   $bytes=(Get-Item -LiteralPath $duplicate).Length;Remove-Item -LiteralPath $resolved -Force
   $result.cleanup+=@{path=$resolved;deletedFiles=1;deletedMb=[math]::Round($bytes/1MB,1);verifiedDuplicate=$true}
  }
 }
 $result.phase='complete'
}catch{$result.phase='failed';$result.error=[string]$_.Exception.Message}
$result.freeDiskMbAfter=Free-DiskMb
$result.reclaimedMb=$result.freeDiskMbAfter-$result.freeDiskMbBefore
$result.originalMt5Preserved=@($result.originalMt5Pids|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count -eq @($result.originalMt5Pids).Count
$result.agentTaskState=[string](Get-ScheduledTask -TaskName 'CornGridSandboxAgent').State
$result.freeRamMbAfter=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
Save-Report
