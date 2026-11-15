$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $process=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 Get-Content (Join-Path $PSScriptRoot 'availability-deployment-result.json') -ErrorAction SilentlyContinue
 if($process.ExitCode -ne 0){throw 'Availability repair deployment failed'}
 exit
}
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'Corngrid-web'
$target='C:\Website\Website\Corngrid-web'
$backup=Join-Path $env:TEMP ('CornGrid-availability-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
$result=Join-Path $PSScriptRoot 'availability-deployment-result.json'
try{
 $files=@('service\watchdog.ps1','service\install-watchdog.ps1','service\install.ps1','service\README.md','service\.gitignore','android\app\src\main\java\com\corngrid\app\MainActivity.java','android\app\src\main\res\values\strings.xml','android\app\build.gradle','ANDROID.md')
 foreach($file in $files){
  $dest=Join-Path $target $file
  $saved=Join-Path $backup $file
  New-Item -ItemType Directory -Path (Split-Path $saved -Parent) -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
  if(Test-Path -LiteralPath $dest){Copy-Item -LiteralPath $dest -Destination $saved}
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination $dest -Force
  if((Get-FileHash -LiteralPath (Join-Path $source $file)).Hash -ne (Get-FileHash -LiteralPath $dest).Hash){throw ('Hash mismatch: '+$file)}
 }
 & (Join-Path $target 'service\install-watchdog.ps1') -ProjectDir $target
 Start-Sleep -Seconds 12
 $statePath=Join-Path $target 'service\watchdog-state.json'
 $state=$(if(Test-Path -LiteralPath $statePath){Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json}else{$null})
 $task=Get-ScheduledTask CornGridWebsiteWatchdog
 @{success=$true;backup=$backup;task=$task.State.ToString();watchdog=$state;time=(Get-Date).ToString('o')} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $result
}catch{
 @{success=$false;backup=$backup;error=$_.Exception.Message;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $result
 throw
}
