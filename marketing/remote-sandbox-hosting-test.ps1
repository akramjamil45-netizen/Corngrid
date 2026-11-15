$ErrorActionPreference='Stop'
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$resultFile=Join-Path $workspace 'marketing\remote-sandbox-hosting-test-result.json'
$result=[ordered]@{hostname=$env:COMPUTERNAME;phase='starting';requestedCapacity=2;eaTradingTested=$false;brokerLoginTested=$false}
$owned=@();$work=$null
function Save-Result { [IO.File]::WriteAllText($resultFile,($result|ConvertTo-Json -Compress -Depth 8)) }
try{
 if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Unexpected target host/account.'}
 $config=Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw|ConvertFrom-Json
 if($config.nodeUid -ne 'node_1677e8779f05aa567b'){throw 'Unexpected configured node.'}
 $existing=@(Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object Id,Path)
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $size=(Get-ChildItem -LiteralPath $config.mt5BaseDir -Recurse -File|Measure-Object Length -Sum).Sum
 if($disk.FreeSpace -lt ($size*2+200MB)){throw 'Insufficient headroom for two disposable MT5 test copies.'}
 $work='C:\CornGrid\Diagnostics\HostingSmoke-'+[Guid]::NewGuid().ToString('N')
 New-Item -ItemType Directory -Path $work -Force|Out-Null
 $result.phase='preparing-two-disposable-terminals';Save-Result
 $paths=@()
 foreach($number in 1,2){
  $directory=Join-Path $work ('Slot'+$number);New-Item -ItemType Directory -Path $directory|Out-Null
  Get-ChildItem -LiteralPath $config.mt5BaseDir -Force|Copy-Item -Destination $directory -Recurse
  $startupDir=Join-Path $directory 'config';New-Item -ItemType Directory -Path $startupDir -Force|Out-Null
  $startup=Join-Path $startupDir 'hosting-smoke.ini'
  [IO.File]::WriteAllText($startup,"[Common]`r`nLogin=0`r`nPassword=`r`nServer=`r`nKeepPrivate=1`r`n`r`n[Experts]`r`nEnabled=0`r`nAllowLiveTrading=0`r`nAllowDllImport=0`r`n`r`n[StartUp]`r`n",[Text.Encoding]::Unicode)
  $terminal=Join-Path $directory 'terminal64.exe'
  $process=Start-Process -FilePath $terminal -ArgumentList @('/portable',('/config:"'+$startup+'"')) -WorkingDirectory $directory -WindowStyle Hidden -PassThru
  $owned+=@{id=$process.Id;path=$terminal};$paths+=$terminal
 }
 $result.phase='testing-two-terminals-in-parallel';Save-Result
 Start-Sleep -Seconds 10
 $running=@();foreach($item in $owned){$p=Get-Process -Id $item.id -ErrorAction SilentlyContinue;if($p -and $p.Path -eq $item.path){$running+=@{pid=$p.Id;memoryMb=[math]::Round($p.WorkingSet64/1MB);responsive=$p.Responding}}}
 $result.concurrentTerminals=$running.Count;$result.terminals=$running
 $result.originalTerminalPreserved=@($existing|Where-Object{Get-Process -Id $_.Id -ErrorAction SilentlyContinue}).Count -eq $existing.Count
 $os=Get-CimInstance Win32_OperatingSystem;$result.freeRamMbDuringTest=[math]::Round($os.FreePhysicalMemory/1024)
 if($running.Count -ne 2){throw 'Both disposable MT5 terminals did not remain running.'}
 $probe=Join-Path $work 'ipc_probe.py'
 @'
import sys,json
sys.path.insert(0,r'C:\CornGrid\agent\broker-python')
import MetaTrader5 as mt5
out=[]
for terminal in sys.argv[1:]:
    ok=mt5.initialize(terminal,timeout=15000,portable=True)
    info=mt5.terminal_info() if ok else None
    out.append(dict(initialized=bool(ok),terminalInfoAvailable=info is not None,connected=bool(info.connected) if info else False,errorCode=None if ok else mt5.last_error()[0]))
    mt5.shutdown()
print(json.dumps(out))
'@|Set-Content -LiteralPath $probe -Encoding UTF8
 $result.phase='testing-python-ipc';Save-Result
 $ErrorActionPreference='Continue';$ipc=& $config.mt5PythonPath $probe @paths 2>(Join-Path $work 'ipc-error.log');$ipcExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($ipcExit -eq 0){$result.pythonIpc=$ipc|ConvertFrom-Json}else{$result.pythonIpcErrorCode=$ipcExit}
 $result.pythonIpcPassed=$ipcExit -eq 0 -and @($result.pythonIpc|Where-Object{$_.initialized}).Count -eq 2
 $result.phase='runtime-test-complete';Save-Result
}catch{$result.phase='failed';$result.error=$_.Exception.Message;Save-Result}
finally{
 foreach($item in $owned){
  $p=Get-Process -Id $item.id -ErrorAction SilentlyContinue
  if($p -and $p.Path -eq $item.path -and $p.Path.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)){[void]$p.CloseMainWindow();if(-not $p.WaitForExit(5000)){Stop-Process -Id $p.Id -Force}}
 }
 if($work){
  $resolved=[IO.Path]::GetFullPath($work)
  if($resolved -notmatch '^C:\\CornGrid\\Diagnostics\\HostingSmoke-[a-f0-9]{32}$'){throw 'Unsafe test cleanup path.'}
  $left=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolved+'\',[StringComparison]::OrdinalIgnoreCase)})
  if(-not $left.Count){Remove-Item -LiteralPath $resolved -Recurse -Force;$result.disposableTestsCleaned=$true}
 }
 $result.freeDiskMbAfterTest=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
 Save-Result
}
