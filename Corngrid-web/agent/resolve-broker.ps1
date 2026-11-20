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
$terminal=Join-Path $InstanceDir 'terminal64.exe'
$result=Join-Path $InstanceDir 'config\broker-preflight-result.json'
$startup=Join-Path $InstanceDir 'config\broker-preflight.ini'
$phase='starting the isolated terminal'
# With a probe terminal the IPC pipe is already owned by the dedicated keeper,
# so the instance copy must stay untouched: starting a second terminal cannot
# bind port 22346 and the Python bridge would attach to the keeper anyway.
$probePath=''
if(-not [string]::IsNullOrWhiteSpace($ProbeTerminal)){
 $probePath=[IO.Path]::GetFullPath($ProbeTerminal)
 if(-not (Test-Path -LiteralPath (Join-Path $probePath 'terminal64.exe'))){throw 'IPC probe terminal is missing'}
}
# $Search is kept for the caller contract. Broker discovery is no longer needed:
# the cached config\servers.dat already lists the broker access points.
# The terminal must be the only one running from this directory, otherwise the
# Python bridge attaches to a process that still holds another account.
function Stop-IsolatedTerminal {
 $targets=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminal })
 foreach($target in $targets){
  $item=Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
  if($item){[void]$item.CloseMainWindow();if(-not $item.WaitForExit(5000)){Stop-Process -Id $item.Id -Force}}
 }
}
try {
 if(-not (Test-Path -LiteralPath $terminal)){throw 'MT5 terminal is missing'}
 if(-not (Test-Path -LiteralPath $startup)){throw 'Broker preflight file is missing'}
 # The login itself happens in broker-probe.py through the official Python
 # bridge: MetaTrader5.initialize() with the account credentials authorizes a
 # fresh terminal and writes config\accounts.dat. Starting the terminal and
 # letting it read a startup file never authorized a new sandbox, and the
 # terminal then never answered the IPC pipe (code -10005).
 if($probePath){
  $phase='verifying broker login through the IPC probe terminal'
  & $PythonPath (Join-Path $PSScriptRoot 'broker-probe.py') $InstanceDir $RequestId $probePath | Out-Null
 } else {
  Stop-IsolatedTerminal
  $phase='verifying broker login and reading account symbols'
  & $PythonPath (Join-Path $PSScriptRoot 'broker-probe.py') $InstanceDir $RequestId | Out-Null
 }
 if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $result)){throw 'Python MT5 verification failed'}
}catch{
 $message='MT5 preflight failed while '+$phase+'. Check the English MT5 terminal, Python tools and broker connectivity.'
 if(-not (Test-Path -LiteralPath $result)){
  @{ok=$false;requestId=$RequestId;error=$message} | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
 }
}finally{
 if(-not $probePath){ Stop-IsolatedTerminal }
}
