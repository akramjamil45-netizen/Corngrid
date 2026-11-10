param(
 [string]$StatePath=(Join-Path $PSScriptRoot 'watchdog-state.json'),
 [string]$ProbeUrl='http://127.0.0.1:3000/api/health/ready',
 [string]$PublicUrl='https://corngrid.com/api/health',
 [switch]$DryRun
)
$ErrorActionPreference='Stop'
$probe=[Uri]$ProbeUrl
if(-not $probe.IsLoopback -or $probe.Scheme -notin @('http','https')){throw 'Origin probe must use loopback HTTP(S)'}
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'watchdog.pause')){Write-Output 'Watchdog paused for maintenance.';exit}
function Test-Health([string]$url,[int]$seconds){
 try{
  $response=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec $seconds -Headers @{'Cache-Control'='no-cache'}
  $body=$response.Content | ConvertFrom-Json
  return @{healthy=($response.StatusCode -eq 200 -and $body.status -eq 'ok');status=[int]$response.StatusCode}
 }catch{
  $status=0
  if($_.Exception.Response){$status=[int]$_.Exception.Response.StatusCode}
  return @{healthy=$false;status=$status}
 }
}
$state=@{originFailures=0;tunnelFailures=0;lastOriginRecovery=0;lastTunnelRecovery=0}
if(Test-Path -LiteralPath $StatePath){
 try{$old=Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json;foreach($key in @($state.Keys)){if($null -ne $old.$key){$state[$key]=[long]$old.$key}}}catch{}
}
$origin=Test-Health $ProbeUrl 4
$public=Test-Health $PublicUrl 6
$now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$actions=@()
$state.originFailures=$(if($origin.healthy){0}else{$state.originFailures+1})
if(-not $origin.healthy -and $state.originFailures -ge 3 -and ($now-$state.lastOriginRecovery) -ge 600){
 $state.lastOriginRecovery=$now
 if($DryRun){$actions+='would-recover-website'}else{
  try{if((Get-Service CornGridWeb).Status -eq 'Stopped'){Start-Service CornGridWeb}else{Restart-Service CornGridWeb};$actions+='recovered-website'}catch{$actions+='website-recovery-failed'}
 }
}
$tunnel=Get-Service Cloudflared -ErrorAction SilentlyContinue
$tunnelFailure=$origin.healthy -and -not $public.healthy -and ($public.status -in @(502,503,504,530) -or ($tunnel -and $tunnel.Status -eq 'Stopped'))
$state.tunnelFailures=$(if($tunnelFailure){$state.tunnelFailures+1}else{0})
if($tunnel -and $tunnelFailure -and $state.tunnelFailures -ge 3 -and ($now-$state.lastTunnelRecovery) -ge 600){
 $state.lastTunnelRecovery=$now
 if($DryRun){$actions+='would-recover-tunnel'}else{
  try{if($tunnel.Status -eq 'Stopped'){Start-Service Cloudflared}else{Restart-Service Cloudflared};$actions+='recovered-tunnel'}catch{$actions+='tunnel-recovery-failed'}
 }
}
$state.checkedAt=(Get-Date).ToString('o')
$state.originHealthy=$origin.healthy
$state.publicHealthy=$public.healthy
$state.publicStatus=$public.status
$state.actions=$actions
$state.dryRun=[bool]$DryRun
$directory=Split-Path ([IO.Path]::GetFullPath($StatePath)) -Parent
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$temporary=$StatePath+'.tmp'
$state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $StatePath -Force
if($actions.Count){
 $log=Join-Path $directory 'watchdog.log'
 if((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB){Move-Item -LiteralPath $log -Destination ($log+'.bak') -Force}
 ($state | ConvertTo-Json -Compress) | Add-Content -LiteralPath $log -Encoding UTF8
}
$state | ConvertTo-Json -Compress | Write-Output
