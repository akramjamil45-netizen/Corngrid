param([switch]$Apply)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$helper=Join-Path $PSScriptRoot 'deploy-workplace-ux.cjs'
if(-not $Apply){& node.exe $helper inspect;exit $LASTEXITCODE}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Apply') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Workplace UI deployment failed; inspect the rollout report.'}
 Get-Content -LiteralPath (Join-Path $PSScriptRoot 'workplace-ux-rollout-result.json');exit
}
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('workplace-ux-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$null=New-Item -ItemType Directory -Path $backup
& icacls.exe $backup /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot restrict backup access.'}
$report=Join-Path $PSScriptRoot 'workplace-ux-rollout-result.json'
$result=[ordered]@{phase='preparing';backup=$backup;serverRestarted=$false;startedAt=[DateTime]::UtcNow.ToString('o')}
function Save-Report {[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 8))}
function Node-Operation([string]$mode){$raw=& node.exe $helper $mode $backup;if($LASTEXITCODE -ne 0){throw ('Workplace UI '+$mode+' failed.')};return ($raw -join [Environment]::NewLine)|ConvertFrom-Json}
$before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
$attempted=$false
try{
 $result.prepare=Node-Operation 'prepare';Save-Report
 $attempted=$true;$result.apply=Node-Operation 'apply';$result.phase='verifying';Save-Report
 if($result.prepare.backendRestartRequired){Restart-Service -Name CornGridWeb;$result.serverRestarted=$true;Save-Report}
 $ready=$false
 foreach($attempt in 1..20){try{$health=Invoke-RestMethod 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3;if($health.status -eq 'ok'){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Backend readiness failed.'}
 $result.verification=Node-Operation 'verify'
 $result.public=Node-Operation 'public'
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $result.terminalPidsPreserved=$before;$result.phase='complete';$result.completedAt=[DateTime]::UtcNow.ToString('o');Save-Report
 $result|ConvertTo-Json -Depth 8
}catch{
 $result.phase='failed';$result.reason=$_.Exception.Message
 if($attempted){try{$result.rollback=Node-Operation 'rollback';if($result.prepare.backendRestartRequired){Restart-Service -Name CornGridWeb}}catch{$result.rollbackError=$_.Exception.Message}}
 Save-Report;throw
}
