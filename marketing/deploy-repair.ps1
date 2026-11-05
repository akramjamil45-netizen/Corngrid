param([switch]$SkipRestart)
$ErrorActionPreference = 'Stop'
$taskSource = Split-Path -Parent $PSScriptRoot
$taskDestination = 'C:\Website\Website'
$taskBackup = Join-Path ([IO.Path]::GetTempPath()) ('CornGrid-ui-repair-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskFiles = @(
 'index.html','en/index.html','corngrid-ea.html','site.js','infrastructure.css','sw.js',
 'locales/ms.json','locales/en.json','marketing/build.js','marketing/ea-footer.js','marketing/header.html','marketing/support.html',
 'promote/terminal-app/index.html',
 'Corngrid-web/marketing-routes.js','Corngrid-web/public/public-portfolios.html',
 'Corngrid-web/public/public-portfolio.html','Corngrid-web/public/public-shell.css',
 'Corngrid-web/public/pwa.js','Corngrid-web/public/pwa.css'
)
foreach ($taskFile in $taskFiles) {
 if (-not (Test-Path -LiteralPath (Join-Path $taskSource $taskFile))) { throw "Missing source: $taskFile" }
}
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
# Save production files before replacing any assets. Keep backups outside the web root.
foreach ($taskFile in @($taskFiles + @('web.config','web.config.xml'))) {
 $taskExisting = Join-Path $taskDestination $taskFile
 if (Test-Path -LiteralPath $taskExisting) {
  $taskBackupFile = Join-Path $taskBackup $taskFile
  New-Item -ItemType Directory -Path (Split-Path -Parent $taskBackupFile) -Force | Out-Null
  Copy-Item -LiteralPath $taskExisting -Destination $taskBackupFile -Force
 }
}
foreach ($taskFile in $taskFiles) {
 $taskTarget = Join-Path $taskDestination $taskFile
 New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
 Copy-Item -LiteralPath (Join-Path $taskSource $taskFile) -Destination $taskTarget -Force
 if ((Get-FileHash -LiteralPath (Join-Path $taskSource $taskFile)).Hash -ne (Get-FileHash -LiteralPath $taskTarget).Hash) { throw "Hash mismatch: $taskFile" }
}
# Patch the actual hosting rules rather than replacing production configuration.
foreach ($taskFile in @('web.config','web.config.xml')) {
 $taskTarget = Join-Path $taskDestination $taskFile
 if (-not (Test-Path -LiteralPath $taskTarget)) { continue }
 $taskConfig = [IO.File]::ReadAllText($taskTarget)
 if (-not $taskConfig.Contains('public-shell\.css')) {
  $taskUpdated = $taskConfig.Replace('pwa\.(?:css|js)|images/', 'pwa\.(?:css|js)|public-shell\.css|images/')
  if ($taskUpdated -eq $taskConfig) { throw "Could not locate PWA proxy allowlist in $taskFile" }
  [xml]$taskValidated = $taskUpdated
  [IO.File]::WriteAllText($taskTarget, $taskUpdated)
 }
}
@{ backup = $taskBackup; files = $taskFiles; deployedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json')
Write-Output "Deployed and hash-verified $($taskFiles.Count) files. Backup: $taskBackup"
try {
 if ($SkipRestart) { Write-Output 'Static asset update; service restart not needed.'; exit 0 }
 Restart-Service -Name CornGridWeb -ErrorAction Stop
 Write-Output 'CornGridWeb restarted.'
} catch {
 Write-Output "Files deployed. Service restart requires administrator rights: $($_.Exception.Message)"
}
