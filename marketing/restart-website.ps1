$ErrorActionPreference = 'Stop'
$websiteResult = Join-Path $PSScriptRoot 'website-restart-result.json'
try {
 $websitePrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
 if (-not $websitePrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $websiteChild = Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($websiteChild.ExitCode -ne 0) { throw 'Elevated website restart failed. Check the result file.' }
  exit
 }
 Restart-Service -Name CornGridWeb -ErrorAction Stop
 $websiteHealth = $null
 for ($websiteAttempt = 0; $websiteAttempt -lt 20; $websiteAttempt++) {
  try {
   $websiteHealth = Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 3
   if ($websiteHealth.status -eq 'ok') { break }
  } catch {}
  Start-Sleep -Seconds 1
 }
 if ($websiteHealth.status -ne 'ok') { throw 'Website service restarted but health check did not return ok.' }
 @{ success=$true; service=(Get-Service CornGridWeb).Status.ToString(); health=$websiteHealth; time=(Get-Date).ToString('o') } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $websiteResult
} catch {
 @{ success=$false; error=$_.Exception.Message; time=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $websiteResult
 throw
}
