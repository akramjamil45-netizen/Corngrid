$ErrorActionPreference = 'Stop'
$reportRollout = Join-Path $PSScriptRoot 'deploy-report-studio.cjs'
$reportRestart = Join-Path $PSScriptRoot 'restart-website.ps1'
$reportApplied = $false
try {
  & node $reportRollout --apply
  if ($LASTEXITCODE -ne 0) { throw 'Report Studio preflight or file deployment failed.' }
  $reportApplied = $true
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reportRestart
  if ($LASTEXITCODE -ne 0) { throw 'Website restart failed.' }
  & node $reportRollout --verify
  if ($LASTEXITCODE -ne 0) { throw 'Live verification failed.' }
} catch {
  $reportFailure = $_.Exception.Message
  if ($reportApplied) {
    & node $reportRollout --rollback
    if ($LASTEXITCODE -eq 0) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reportRestart
    }
  }
  throw $reportFailure
}
