$ErrorActionPreference='Stop'
$testRoot=Join-Path $env:TEMP ('CornGrid-watchdog-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$state=Join-Path $testRoot 'state.json'
$script=Join-Path (Split-Path $PSScriptRoot -Parent) 'Corngrid-web\service\watchdog.ps1'
$results=@()
for($i=1;$i -le 4;$i++){
 $check=& $script -StatePath $state -ProbeUrl 'http://127.0.0.1:4322/fail' -PublicUrl 'http://127.0.0.1:4322/ok' -DryRun | ConvertFrom-Json
 $results+=@{attempt=$i;failures=$check.originFailures;actions=$check.actions}
 if($i -lt 3 -and $check.actions.Count){throw 'Premature recovery'}
 if($i -eq 3 -and $check.actions -notcontains 'would-recover-website'){throw 'Missing recovery'}
 if($i -eq 4 -and $check.actions.Count){throw 'Recovery cooldown failed'}
}
$healthy=& $script -StatePath $state -ProbeUrl 'http://127.0.0.1:4322/ok' -PublicUrl 'http://127.0.0.1:4322/ok' -DryRun | ConvertFrom-Json
if($healthy.originFailures -ne 0){throw 'Healthy check did not reset failures'}
$results | ConvertTo-Json -Depth 4
Write-Output 'Failure threshold, recovery cooldown and healthy reset passed; no service was restarted.'
if(Get-Service Cloudflared -ErrorAction SilentlyContinue){
 for($i=1;$i -le 4;$i++){
  $check=& $script -StatePath $state -ProbeUrl 'http://127.0.0.1:4322/ok' -PublicUrl 'http://127.0.0.1:4322/fail' -DryRun | ConvertFrom-Json
  if($i -lt 3 -and $check.actions.Count){throw 'Premature tunnel recovery'}
  if($i -eq 3 -and $check.actions -notcontains 'would-recover-tunnel'){throw 'Missing tunnel recovery'}
  if($i -eq 4 -and $check.actions.Count){throw 'Tunnel cooldown failed'}
 }
 $dns=& $script -StatePath $state -ProbeUrl 'http://127.0.0.1:4322/ok' -PublicUrl 'http://127.0.0.1:4323/unavailable' -DryRun | ConvertFrom-Json
 if($dns.tunnelFailures -ne 0 -or $dns.actions.Count){throw 'Ordinary network failure must not restart a healthy tunnel'}
 Write-Output 'Tunnel gateway failure threshold, cooldown and network-failure isolation passed.'
}
