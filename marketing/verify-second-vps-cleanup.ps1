$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne 'node_1c5492c9d49db1d045'){throw 'Wrong node.'}
$r=[ordered]@{hostname=$env:COMPUTERNAME;phase='checking'}
try{
 $cleanup=Get-Content -LiteralPath 'C:\CornGrid\cleanup-result.json' -Raw|ConvertFrom-Json
 if($cleanup.phase -ne 'complete'){throw 'Cleanup is incomplete.'}
 $r.mt4Present=Test-Path -LiteralPath 'C:\Program Files (x86)\RoboForex - MetaTrader 4\terminal.exe'
 $r.firefoxPresent=Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox\firefox.exe'
 $r.mozillaPrograms=@();foreach($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')){
  $r.mozillaPrograms+=@(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue|Where-Object{$_.Publisher -like '*Mozilla*'}|ForEach-Object{$_.DisplayName})
 }
 # Remove only broken MT4 shortcuts, after checking their exact target directory.
 $r.removedShortcuts=@();$shell=New-Object -ComObject WScript.Shell
 foreach($desktop in @('C:\Users\Administrator\Desktop','C:\Users\Public\Desktop')){
  foreach($link in Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File -ErrorAction SilentlyContinue){
   $target=$shell.CreateShortcut($link.FullName).TargetPath
   if($target -and $target.StartsWith('C:\Program Files (x86)\RoboForex - MetaTrader 4\',[StringComparison]::OrdinalIgnoreCase) -and -not(Test-Path -LiteralPath $target)){
    $resolved=[IO.Path]::GetFullPath($link.FullName)
    if([IO.Path]::GetDirectoryName($resolved) -ne $desktop){throw 'Unsafe shortcut path.'}
    Remove-Item -LiteralPath $resolved;$r.removedShortcuts+=$link.Name
   }
  }
 }
 $r.services=@(Get-CimInstance Win32_Service|Where-Object{$_.Name -in @('DiagTrack','SysMain','WSearch','Spooler','WinDefend','mpssvc','TermService','Schedule','wuauserv','BITS')}|ForEach-Object{@{name=$_.Name;state=$_.State;startMode=$_.StartMode}})
 $r.mt5Preserved=[bool](Get-Process -Id 5220 -ErrorAction SilentlyContinue)
 $r.taskState=[string](Get-ScheduledTask -TaskName CornGridSandboxManagedAgent).State
 Set-Location -LiteralPath 'C:\CornGrid\agent'
 $ErrorActionPreference='Continue'
 & 'C:\Program Files\nodejs\node.exe' '.\check-installation.js' --online *> 'C:\CornGrid\post-cleanup-check.log'
 $r.checkExitCode=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($r.checkExitCode -ne 0){throw 'Installation checks failed.'}
 if($r.mt4Present -or $r.firefoxPresent -or $r.mozillaPrograms.Count){throw 'Removed application remains installed.'}
 if(-not $r.mt5Preserved -or $r.taskState -ne 'Running'){throw 'Trading or agent process is not healthy.'}
 if(@($r.services|Where-Object{$_.name -in @('DiagTrack','SysMain','WSearch','Spooler') -and ($_.startMode -ne 'Disabled' -or $_.state -ne 'Stopped')}).Count){throw 'Optional service is still enabled.'}
 if(@($r.services|Where-Object{$_.name -in @('WinDefend','mpssvc','TermService','Schedule') -and $_.state -ne 'Running'}).Count){throw 'An essential service is not running.'}
 $r.diskFreeMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
 $r.freeRamMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
 $r.settingsBackup=$cleanup.settingsBackup;$r.phase='complete'
}catch{$r.phase='failed';$r.error=$_.Exception.Message}
$r.checkedAt=[DateTime]::UtcNow.ToString('o');$json=$r|ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText('C:\CornGrid\cleanup-verification.json',$json)
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-cleanup-verification.json',$json)
