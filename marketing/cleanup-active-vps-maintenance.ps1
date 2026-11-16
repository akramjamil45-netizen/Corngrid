$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong VPS/account.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Wrong CornGrid node.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-maintenance-cleanup-result.json'
$r=[ordered]@{hostname=$env:COMPUTERNAME;at=[DateTime]::UtcNow.ToString('o');phase='starting';actions=@();cleanup=@();skipped=@()}
function Save-Report {[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 7 -Compress))}
function Free-Mb {return [math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)}
$roots=@('C:\Windows\Temp','C:\Users\Administrator\AppData\Local\Temp','C:\Windows\SoftwareDistribution\Download','C:\Users\Administrator\AppData\Local\Google\Chrome\User Data\Default\Cache','C:\Users\Administrator\AppData\Local\Google\Chrome\User Data\Default\Code Cache','C:\Users\Administrator\AppData\Local\Google\Chrome\User Data\Default\GPUCache')
function Clear-Cache([string]$root,[DateTime]$cutoff){
 $absolute=[IO.Path]::GetFullPath($root).TrimEnd('\');if($roots -notcontains $absolute){throw 'Cache root is not approved.'}
 $stats=@{path=$absolute;deletedFiles=0;deletedMb=0;skipped=0};$bytes=0L
 if(-not(Test-Path -LiteralPath $absolute -PathType Container)){return $stats}
 $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($absolute)
 while($pending.Count){$directory=[IO.Path]::GetFullPath($pending.Pop());if($directory -ne $absolute -and -not $directory.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cache escaped approved root.'}
  if(([IO.File]::GetAttributes($directory)) -band [IO.FileAttributes]::ReparsePoint){continue}
  try{$entries=@([IO.Directory]::EnumerateFileSystemEntries($directory))}catch{continue}
  foreach($entry in $entries){try{$full=[IO.Path]::GetFullPath($entry);if(-not $full.StartsWith($absolute+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cache path.'}
   $attrs=[IO.File]::GetAttributes($full);if($attrs -band [IO.FileAttributes]::ReparsePoint){continue};if($attrs -band [IO.FileAttributes]::Directory){$pending.Push($full);continue}
   $file=[IO.FileInfo]$full;if($file.LastWriteTimeUtc -ge $cutoff){continue};$length=$file.Length
   Remove-Item -LiteralPath $full -Force -ErrorAction Stop;$bytes+=$length;$stats.deletedFiles++
  }catch{$stats.skipped++}}
 }
 $stats.deletedMb=[math]::Round($bytes/1MB,1);return $stats
}
function Uninstall-Browser([string]$name,[string]$publisher,[string]$processName){
 if(@(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count){$r.skipped+=($name+': browser is in use');return}
 $programs=@();foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')){$programs+=@(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -eq $name -and $_.Publisher -eq $publisher})}
 if(-not $programs.Count){$r.skipped+=($name+': not installed');return}
 if($programs.Count -ne 1){throw 'Ambiguous browser uninstall entry.'}
 $match=[regex]::Match([string]$programs[0].UninstallString,'^(?:"?MsiExec\.exe"?)\s+/X(\{[A-Fa-f0-9-]{36}\})$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
 if(-not $match.Success){$r.skipped+=($name+': unexpected uninstaller; no arbitrary command executed');return}
 $p=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList @('/x',$match.Groups[1].Value,'/qn','/norestart') -WindowStyle Hidden -PassThru
 if(-not $p.WaitForExit(120000)){throw 'Browser uninstall still running; inspect before retrying.'};$p.Refresh()
 $r.actions+=@{action='uninstall-browser';name=$name;exitCode=$p.ExitCode};Save-Report
 if($p.ExitCode -notin @(0,1605,3010)){$r.skipped+=($name+': Windows Installer did not complete removal')}
 if($p.ExitCode -eq 3010){$r.rebootRecommended=$true}
}
try{
 $r.freeDiskMbBefore=Free-Mb;$r.freeRamMbBefore=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
 $r.mt5PidsBefore=@(Get-Process terminal64,terminal -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 $r.agentPidsBefore=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -like '*CornGrid*agent.js*'}|ForEach-Object{$_.ProcessId})
 Save-Report
 $r.phase='cleaning-temporary-files';Save-Report
 foreach($root in $roots[0..1]){$r.cleanup+=,(Clear-Cache $root ([DateTime]::UtcNow.AddDays(-2)))}
 $servicing=@(Get-Process TiWorker,dism,setuphost,msiexec -ErrorAction SilentlyContinue)
 $installer=Get-Service TrustedInstaller -ErrorAction SilentlyContinue
 $pending=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
 $r.pendingWindowsReboot=[bool]$pending
 if($servicing.Count -or ($installer -and $installer.Status -eq 'Running') -or $pending){$r.skipped+='Windows Update cache: servicing/reboot pending'}else{
  $resume=@();try{
   foreach($name in @('wuauserv','BITS')){$service=Get-Service -Name $name -ErrorAction SilentlyContinue;if($service -and $service.Status -ne 'Stopped'){$resume+=$name;Stop-Service -Name $name -ErrorAction Stop}}
   # Download payloads are regenerable. DataStore, Installer and WinSxS stay intact.
   $r.cleanup+=,(Clear-Cache 'C:\Windows\SoftwareDistribution\Download' ([DateTime]::UtcNow.AddDays(-1)))
  }finally{foreach($name in $resume){Start-Service -Name $name -ErrorAction Continue}}
 }
 if(-not @(Get-Process chrome -ErrorAction SilentlyContinue).Count){foreach($root in $roots[3..5]){$r.cleanup+=,(Clear-Cache $root ([DateTime]::UtcNow.AddDays(-1)))}}
 $r.freeDiskMbAfterCaches=Free-Mb;$r.phase='uninstalling-unused-browsers';Save-Report
 Uninstall-Browser 'Google Chrome' 'Google LLC' 'chrome'
 Uninstall-Browser 'Microsoft Edge' 'Microsoft Corporation' 'msedge'
 # Preserve WebView2: the running MT5 terminal uses it. Preserve all trading
 # terminals, Python/Node runtimes, Defender, networking, RDP and provider tools.
 $r.phase='disabling-browser-background';Save-Report
 $settings=@();foreach($policy in @(@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='StartupBoostEnabled'},@{key='HKLM:\SOFTWARE\Policies\Microsoft\Edge';name='BackgroundModeEnabled'},@{key='HKLM:\SOFTWARE\Policies\Google\Chrome';name='BackgroundModeEnabled'})){
  $existing=Get-Item -LiteralPath $policy.key -ErrorAction SilentlyContinue;$has=$existing -and $existing.GetValueNames() -contains $policy.name
  $settings+=@{key=$policy.key;name=$policy.name;existed=[bool]$has;value=if($has){$existing.GetValue($policy.name)}else{$null}}
 }
 [IO.File]::WriteAllText((Join-Path $workspace 'marketing\second-vps-maintenance-settings-result.json'),($settings|ConvertTo-Json -Depth 5))
 foreach($policy in $settings){if(-not(Test-Path -LiteralPath $policy.key)){New-Item -Path $policy.key -Force|Out-Null};New-ItemProperty -LiteralPath $policy.key -Name $policy.name -Value 0 -PropertyType DWord -Force|Out-Null;$r.actions+=@{action='disable-browser-background';name=$policy.name;key=$policy.key}}
 $r.phase='complete'
}catch{$r.phase='failed';$r.error=$_.Exception.Message}
$r.freeDiskMbAfter=Free-Mb;$r.reclaimedMb=$r.freeDiskMbAfter-$r.freeDiskMbBefore;$r.freeRamMbAfter=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
$after=@(Get-Process terminal64,terminal -ErrorAction SilentlyContinue|ForEach-Object{$_.Id});$r.mt5PidsPreserved=@($r.mt5PidsBefore|Where-Object{$_ -notin $after}).Count -eq 0
$agentAfter=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.CommandLine -like '*CornGrid*agent.js*'}|ForEach-Object{$_.ProcessId});$r.agentPidsPreserved=@($r.agentPidsBefore|Where-Object{$_ -notin $agentAfter}).Count -eq 0
$r.agentTaskState=[string](Get-ScheduledTask -TaskName 'CornGridSandboxManagedAgent').State
$r.completedAt=[DateTime]::UtcNow.ToString('o');Save-Report
