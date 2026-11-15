$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-ipc-result.json'
$report=@{hostname=[string]$env:COMPUTERNAME;phase='starting';readOnly=$true;brokerLoginTested=$false;eaTradingTested=$false}
try{
 $terminal=Get-Process -Id 3172 -ErrorAction Stop
 $expected='C:\Program Files\RoboForex MT5 Terminal\terminal64.exe'
 if($terminal.Path -ne $expected -or $terminal.SessionId -ne (Get-Process -Id $PID).SessionId){throw 'Original terminal is unavailable in this Windows session.'}
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 $probe='C:\CornGrid\Sandbox\AgentData\read-only-ipc-check.py'
 @'
import sys,json
sys.path.insert(0,r'C:\CornGrid\agent\broker-python')
import MetaTrader5 as mt5
try:
    ok=mt5.initialize(r'C:\Program Files\RoboForex MT5 Terminal\terminal64.exe',timeout=15000,portable=False)
    info=mt5.terminal_info() if ok else None
    result=dict(initialized=bool(ok),terminalInfoAvailable=info is not None,
                connected=bool(info.connected) if info else False,
                terminalBuild=info.build if info else None,
                errorCode=None if ok else mt5.last_error()[0])
    print(json.dumps(result))
finally:
    mt5.shutdown()
'@|Set-Content -LiteralPath $probe -Encoding UTF8
 $ErrorActionPreference='Continue'
 $output=& 'C:\Program Files\Python312\python.exe' $probe 2>'C:\CornGrid\Sandbox\AgentData\read-only-ipc-error.log'
 $code=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($code -ne 0){throw 'Read-only IPC probe failed to execute.'}
 $report.ipc=$output|ConvertFrom-Json
 $report.originalTerminalPreserved=[bool](Get-Process -Id 3172 -ErrorAction SilentlyContinue)
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 $report.terminalProcessesUnchanged=@(Compare-Object $before $after).Count -eq 0
 $report.phase='complete'
}catch{$report.phase='failed';$report.error=[string]$_.Exception.Message}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Compress -Depth 5))
