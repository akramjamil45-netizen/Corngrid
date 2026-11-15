$ErrorActionPreference='Continue'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 Get-Content (Join-Path $PSScriptRoot 'android-availability-build.log') -Tail 30 -ErrorAction SilentlyContinue
 if($child.ExitCode -ne 0){exit $child.ExitCode}
 Get-Content (Join-Path $PSScriptRoot 'android-availability-result.json') -ErrorAction SilentlyContinue
 exit
}
$workspace=Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME=Join-Path $env:LOCALAPPDATA 'Android\jdk-21\jdk-21.0.12.1+1'
$env:ANDROID_HOME=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$buildTemp=(Get-Item -LiteralPath $env:TEMP).FullName
$env:TEMP=$buildTemp
$env:TMP=$buildTemp
$env:CORNGRID_ANDROID_BUILD_ROOT=Join-Path $buildTemp ('CornGridAndroidAvailability-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $env:CORNGRID_ANDROID_BUILD_ROOT -Force | Out-Null
$project=Join-Path $workspace 'Corngrid-web\android'
$log=Join-Path $PSScriptRoot 'android-availability-build.log'
Push-Location $project
try{
 & .\gradlew.bat --no-daemon --no-watch-fs --no-configuration-cache --stacktrace --max-workers=2 --project-cache-dir (Join-Path $env:CORNGRID_ANDROID_BUILD_ROOT 'gradle-cache') -I (Join-Path $PSScriptRoot 'android-isolated-build.gradle') :app:assembleDebug :app:testDebugUnitTest *> $log
 $code=$LASTEXITCODE
 Get-Content -LiteralPath $log -Tail 30
 if($code -ne 0){exit $code}
 $apk=Join-Path $env:CORNGRID_ANDROID_BUILD_ROOT 'app\outputs\apk\debug\app-debug.apk'
 if(-not (Test-Path -LiteralPath $apk)){throw 'Built APK missing'}
 @{success=$true;apk=$apk;version='1.0.1';versionCode=2;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'android-availability-result.json')
}finally{Pop-Location}
