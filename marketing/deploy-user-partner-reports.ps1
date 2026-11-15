$ErrorActionPreference = 'Stop'
$partnerReportRollout = Join-Path $PSScriptRoot 'deploy-user-partner-reports.cjs'
$partnerReportRestart = Join-Path $PSScriptRoot 'restart-website.ps1'
$partnerReportApplied = $false
try {
  & node $partnerReportRollout --apply
  if ($LASTEXITCODE -ne 0) { throw 'User/partner report preflight or deployment failed.' }
  $partnerReportApplied = $true
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $partnerReportRestart
  if ($LASTEXITCODE -ne 0) { throw 'Website restart failed.' }
  & node $partnerReportRollout --verify
  if ($LASTEXITCODE -ne 0) { throw 'User/partner report live verification failed.' }
} catch {
  $partnerReportFailure = $_.Exception.Message
  if ($partnerReportApplied) {
    & node $partnerReportRollout --rollback
    if ($LASTEXITCODE -eq 0) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $partnerReportRestart }
  }
  throw $partnerReportFailure
}
