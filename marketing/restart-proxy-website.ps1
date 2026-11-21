$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong website host.'}
$resultFile=Join-Path $PSScriptRoot 'proxy-vps-website-restart-result.json'
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process -FilePath powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -PassThru -Wait
 exit $child.ExitCode
}
try{
 Restart-Service -Name CornGridWeb -ErrorAction Stop
 $ready=$false;foreach($attempt in 1..25){try{if((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/api/health/ready' -TimeoutSec 3).StatusCode -eq 200){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
 if(-not $ready){throw 'Readiness not confirmed.'}
 @{success=$true;service=[string](Get-Service CornGridWeb).Status;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $resultFile -Encoding UTF8
}catch{@{success=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath $resultFile -Encoding UTF8;throw}
