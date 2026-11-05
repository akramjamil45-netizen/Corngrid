$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskProduction = 'C:\Website\Website'
$taskFiles = @('Corngrid-web/chat-api.js','Corngrid-web/admin-api.js','Corngrid-web/public/admin.html','Corngrid-web/public/admin.js','Corngrid-web/public/admin.css','Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.js','Corngrid-web/public/dashboard.css')
$taskBackup = Join-Path ([IO.Path]::GetTempPath()) ('CornGrid-support-repair-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($taskFile in $taskFiles) {
 if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskFile))) { throw "Missing source: $taskFile" }
 if (-not (Test-Path -LiteralPath (Join-Path $taskProduction $taskFile))) { throw "Missing production file: $taskFile" }
}
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
foreach ($taskFile in $taskFiles) {
 $taskBackupFile = Join-Path $taskBackup $taskFile
 New-Item -ItemType Directory -Path (Split-Path -Parent $taskBackupFile) -Force | Out-Null
 Copy-Item -LiteralPath (Join-Path $taskProduction $taskFile) -Destination $taskBackupFile -Force
}
foreach ($taskFile in $taskFiles) {
 Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination (Join-Path $taskProduction $taskFile) -Force
 if ((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskFile)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskProduction $taskFile)).Hash) { throw "Hash mismatch: $taskFile" }
}
@{ backup=$taskBackup;files=$taskFiles;deployedAt=(Get-Date).ToString('o') } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'support-deployment-result.json')
Write-Output "Deployed and hash-verified 8 support repair files. Backup: $taskBackup"
