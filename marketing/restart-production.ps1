$ErrorActionPreference = 'Stop'
$taskResultFile = Join-Path $PSScriptRoot 'restart-result.json'
try {
 Restart-Service -Name CornGridWeb -ErrorAction Stop
 $taskHealthy = $false
 for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
  try {
   $taskResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 3
   if ($taskResponse.StatusCode -eq 200) { $taskHealthy = $true; break }
  } catch { Start-Sleep -Seconds 1 }
 }
 if (-not $taskHealthy) { throw 'Service restarted but health check did not return HTTP 200.' }
 @{success=$true; service=(Get-Service CornGridWeb).Status.ToString(); completedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $taskResultFile
} catch {
 @{success=$false; error=$_.Exception.Message; completedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $taskResultFile
 exit 1
}
