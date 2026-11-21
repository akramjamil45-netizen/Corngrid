param(
 [Parameter(Mandatory=$true)][string]$InstanceDir,
 [Parameter(Mandatory=$true)][string]$Search,
 [Parameter(Mandatory=$true)][string]$PythonPath,
 [Parameter(Mandatory=$true)][string]$RequestId,
 [string]$ProbeTerminal=''
)
$ErrorActionPreference='Stop'
$InstanceDir=[IO.Path]::GetFullPath($InstanceDir)
if((Split-Path $InstanceDir -Leaf) -notmatch '^(sbx|eatest)_[a-f0-9]{18}$'){throw 'Invalid sandbox path'}
$targetDirectory=if($ProbeTerminal){[IO.Path]::GetFullPath($ProbeTerminal)}else{$InstanceDir}
$terminal=Join-Path $targetDirectory 'terminal64.exe'
$result=Join-Path $InstanceDir 'config\broker-preflight-result.json'
$startup=Join-Path $InstanceDir 'config\broker-preflight.ini'
$seed=Join-Path $targetDirectory 'config\servers.dat'
$phase='preparing the isolated terminal'
function Stop-OwnedTerminal {
 foreach($owner in @(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" -ErrorAction Stop|Where-Object{$_.ExecutablePath -and $_.ExecutablePath -ieq $terminal})){
  $process=Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue
  if($process){[void]$process.CloseMainWindow();if(-not $process.WaitForExit(8000)){Stop-Process -Id $process.Id -Force}}
 }
}
function Start-OwnedTerminal([bool]$writable=$false){
 if(@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" -ErrorAction Stop|Where-Object{$_.ExecutablePath -and $_.ExecutablePath -ieq $terminal}).Count){throw 'Owned preflight terminal is already running'}
 $arguments=@('/portable');if(-not $writable){$arguments+=('/config:"'+$startup+'"')}
 $null=Start-Process -FilePath $terminal -ArgumentList $arguments -WorkingDirectory $targetDirectory -WindowStyle Hidden -PassThru
 Start-Sleep -Seconds 2
}
try{
 if(-not(Test-Path -LiteralPath $terminal) -or -not(Test-Path -LiteralPath $startup)){throw 'MT5 preflight files missing'}
 $text=[IO.File]::ReadAllText($startup,[Text.Encoding]::Unicode)
 $expectedServer=([regex]::Match($text,'(?m)^Server=([^\r\n]+)')).Groups[1].Value
 if(-not $expectedServer){throw 'Expected broker server missing'}
 Stop-OwnedTerminal
 $known=$false
 if(Test-Path -LiteralPath $seed){$bytes=[IO.File]::ReadAllBytes($seed);$known=[Text.Encoding]::Unicode.GetString($bytes).IndexOf($expectedServer,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or [Text.Encoding]::UTF8.GetString($bytes).IndexOf($expectedServer,[StringComparison]::OrdinalIgnoreCase) -ge 0}
 Start-OwnedTerminal
 $phase='verifying broker login and reading account symbols'
 & $PythonPath (Join-Path $PSScriptRoot 'broker-probe.py') $InstanceDir $RequestId $targetDirectory|Out-Null
 if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $result)){throw 'Python MT5 verification failed'}
 $first=Get-Content -LiteralPath $result -Raw|ConvertFrom-Json
 if(-not $first.ok -and -not $known){
  Remove-Item -LiteralPath $result -Force
  $phase='discovering the requested broker server'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'discover-broker.ps1') -TerminalDirectory $targetDirectory -Search $Search -ExpectedServer $expectedServer -StartupFile $startup -TimeoutSeconds 90|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Broker discovery failed'}
  $phase='verifying the discovered broker account'
  & $PythonPath (Join-Path $PSScriptRoot 'broker-probe.py') $InstanceDir $RequestId $targetDirectory|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $result)){throw 'Python MT5 verification failed'}
 }
 Stop-OwnedTerminal
 if($ProbeTerminal -and(Test-Path -LiteralPath $seed)){Copy-Item -LiteralPath $seed -Destination (Join-Path $InstanceDir 'config\servers.dat') -Force}
}catch{
 if(-not(Test-Path -LiteralPath $result)){
  @{ok=$false;requestId=$RequestId;error=('MT5 preflight failed while '+$phase+'. Check the English desktop terminal, broker directory and proxy configuration. EA was not started.')}|ConvertTo-Json|Set-Content -LiteralPath $result -Encoding UTF8
 }
}finally{if(-not $ProbeTerminal){Stop-OwnedTerminal}}
