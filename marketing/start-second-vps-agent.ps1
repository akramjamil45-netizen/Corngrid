$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong target host.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-agent-result.json';$r=[ordered]@{phase='starting';hostname=$env:COMPUTERNAME}
function Save {[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Depth 5 -Compress))}
try{
 $runtime=Get-Content (Join-Path $workspace 'marketing\second-vps-runtime-result.json') -Raw|ConvertFrom-Json
 if($runtime.phase -ne 'runtime-ready'){throw 'Runtime installation is incomplete.'}
 $state=Get-Content (Join-Path $workspace 'marketing\second-node-provision-result.json') -Raw|ConvertFrom-Json
 if($state.targetHostname -ne $env:COMPUTERNAME){throw 'Node provisioning target mismatch.'}
 $configFile='C:\CornGrid\agent\agent-config.json'
 if(-not(Test-Path -LiteralPath $configFile)){
  $remote='\\tsclient\C\'+$state.credentialsPath.Substring(3);Copy-Item -LiteralPath $remote -Destination $configFile
 }
 $config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
 if($config.nodeUid -ne $state.nodeUid){throw 'Node identity mismatch.'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & icacls.exe $configFile '/inheritance:r' '/grant:r' ('*'+$sid+':F') '*S-1-5-18:F' '*S-1-5-32-544:F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to protect agent credentials.'}
 $env:PATH='C:\Program Files\nodejs;'+$env:PATH;Set-Location -LiteralPath 'C:\CornGrid\agent'
 $r.phase='verifying-installation';Save
 $ErrorActionPreference='Continue';& node.exe '.\check-installation.js' --online *> 'C:\CornGrid\installation-check.log';$code=$LASTEXITCODE;$ErrorActionPreference='Stop'
 $r.checkExit=$code;if($code -ne 0){throw 'Installation diagnostics failed; inspect installation-check.log.'}
 $r.phase='pinning-auto-update-key';Save
 if(-not(Test-Path -LiteralPath '.\update-trust.pem')){
  $ErrorActionPreference='Continue';& node.exe '.\agent-launcher.js' --trust-update-key *> 'C:\CornGrid\update-trust-check.log';$code=$LASTEXITCODE;$ErrorActionPreference='Stop'
  if($code -ne 0){throw 'Unable to pin the central update public key.'}
 }
 $r.phase='registering-startup-task';Save
 $task=Get-ScheduledTask -TaskName CornGridSandboxManagedAgent -ErrorAction SilentlyContinue
 if(-not $task){& '.\install-service.ps1' -Mode Interactive -TaskName CornGridSandboxManagedAgent}
 $r.taskState=[string](Get-ScheduledTask -TaskName CornGridSandboxManagedAgent).State
 $r.nodeUid=$state.nodeUid;$r.capacity=1;$r.freeDiskMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
 $r.freeRamMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)
 $r.originalMt5Preserved=[bool](Get-Process -Id 5220 -ErrorAction SilentlyContinue)
 $r.phase='agent-started';Save
}catch{$r.phase='failed';$r.error=$_.Exception.Message;Save}
