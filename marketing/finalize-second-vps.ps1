$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong target host.'}
$nodeUid='node_1c5492c9d49db1d045'
$config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
if($config.nodeUid -ne $nodeUid){throw 'Node identity mismatch.'}
$task=Get-ScheduledTask -TaskName CornGridSandboxManagedAgent
if($task.State -ne 'Running'){throw 'Agent task is not running.'}
foreach($name in @('node.zip','python.exe')){
 $target=[IO.Path]::GetFullPath((Join-Path 'C:\CornGrid\InstallTemp' $name))
 if([IO.Path]::GetDirectoryName($target) -ne 'C:\CornGrid\InstallTemp'){throw 'Cleanup path is outside installation cache.'}
 if(Test-Path -LiteralPath $target){
  $item=Get-Item -LiteralPath $target
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe installation cache entry.'}
  Remove-Item -LiteralPath $target -Force
 }
}
$os=Get-CimInstance Win32_OperatingSystem
$processes=@(Get-CimInstance Win32_Process -Filter "name='node.exe'")
$r=[ordered]@{
 phase='agent-started';hostname=$env:COMPUTERNAME;nodeUid=$nodeUid;capacity=1
 taskState=[string]$task.State;autoUpdateKeyPinned=(Test-Path -LiteralPath 'C:\CornGrid\agent\update-trust.pem')
 freeDiskMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
 freeRamMb=[math]::Round($os.FreePhysicalMemory/1024)
 totalRamMb=[math]::Round($os.TotalVisibleMemorySize/1024)
 originalMt5Preserved=[bool](Get-Process -Id 5220 -ErrorAction SilentlyContinue)
 launcherCount=@($processes|Where-Object{$_.CommandLine -like '*agent-launcher.js*'}).Count
 workerCount=@($processes|Where-Object{$_.CommandLine -match '[\\/]agent\.js["\s]*$'}).Count
 demoTradeTestPerformed=$false;checkedAt=[DateTime]::UtcNow.ToString('o')
}
$json=$r|ConvertTo-Json -Compress
[IO.File]::WriteAllText('C:\CornGrid\installation-result.json',$json)
Write-Output $json
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-agent-result.json',$json)
