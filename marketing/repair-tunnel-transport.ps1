$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'tunnel-transport-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Tunnel transport repair failed. Inspect the sanitized result.'};exit
}
$result=[ordered]@{phase='starting';at=[DateTime]::UtcNow.ToString('o');transport='http2';webRestarted=$false}
function Report {$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $out -Encoding UTF8}
$serviceKey='HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared'
$before=$null
try{
 if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong server.'}
 $before=(Get-ItemProperty -LiteralPath $serviceKey -Name ImagePath).ImagePath
 if($before -notmatch 'cloudflared.exe"? tunnel run --token-file C:\\ProgramData\\cloudflared\\token$'){throw 'Unexpected tunnel service configuration. No change made.'}
 $exe='C:\Program Files (x86)\cloudflared\cloudflared.exe'
 & $exe tunnel --protocol http2 run --help *> $null
 if($LASTEXITCODE -ne 0){throw 'Installed cloudflared does not accept the selected transport.'}
 $backup=Join-Path $env:ProgramData ('CornGrid\WebsiteBackups\tunnel-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 [IO.File]::WriteAllText((Join-Path $backup 'service-imagepath-before.txt'),$before)
 $logs='C:\ProgramData\cloudflared\logs';New-Item -ItemType Directory -Path $logs -Force|Out-Null
 & icacls.exe $logs '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect tunnel logs.'}
 $terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 $new=$before -replace ' tunnel run ',(' tunnel --protocol http2 --loglevel warn --log-directory "'+$logs+'" run ')
 $result.backup=$backup;$result.phase='restarting-tunnel';Report
 Set-ItemProperty -LiteralPath $serviceKey -Name ImagePath -Value $new
 Restart-Service -Name Cloudflared
 $ready=$false
 foreach($attempt in 1..25){
  try{$health=Invoke-RestMethod 'http://127.0.0.1:20241/ready' -TimeoutSec 2;if($health.readyConnections -ge 2){$ready=$true;break}}catch{}
  Start-Sleep -Seconds 1
 }
 if(-not $ready){throw 'HTTP/2 tunnel readiness failed.'}
 $public=Invoke-RestMethod 'https://corngrid.com/api/health/ready' -TimeoutSec 8
 if($public.status -ne 'ok'){throw 'Public website readiness failed.'}
 $current=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
 if(@($terminals|Where-Object {$_ -notin $current}).Count){throw 'An existing terminal PID is missing.'}
 $result.phase='complete';$result.readyConnections=$health.readyConnections;$result.publicHealthy=$true;$result.terminalPidsPreserved=$terminals
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message
 if($before -and $result.backup){try{Set-ItemProperty -LiteralPath $serviceKey -Name ImagePath -Value $before;Restart-Service Cloudflared;$result.rolledBack=$true}catch{$result.rolledBack=$false}}
 Report;throw
}
Report
