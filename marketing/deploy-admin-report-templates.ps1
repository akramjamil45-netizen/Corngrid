$ErrorActionPreference = 'Stop'
$templateRollout = Join-Path $PSScriptRoot 'deploy-admin-report-templates.cjs'
$templateRestart = Join-Path $PSScriptRoot 'restart-website.ps1'
$templateApplied = $false
try {
  & node $templateRollout --apply
  if ($LASTEXITCODE -ne 0) { throw 'Admin template preflight or deployment failed.' }
  $templateApplied = $true
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $templateRestart
  if ($LASTEXITCODE -ne 0) { throw 'Website restart failed.' }
  & node $templateRollout --verify
  if ($LASTEXITCODE -ne 0) { throw 'Admin template live verification failed.' }
} catch {
  $templateFailure = $_.Exception.Message
  if ($templateApplied) {
    & node $templateRollout --rollback
    if ($LASTEXITCODE -eq 0) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $templateRestart }
  }
  throw $templateFailure
}
