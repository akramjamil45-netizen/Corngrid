$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskProduction = 'C:\Website\Website'
$taskBackup = Join-Path ([IO.Path]::GetTempPath()) ('CornGrid-admin-log-clear-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskFiles = @('Corngrid-web/sandbox/sandbox-admin-api.js','Corngrid-web/public/admin-sandbox.js','Corngrid-web/public/admin.html')
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
foreach ($taskFile in $taskFiles) {
 $taskSource = Join-Path $taskRoot $taskFile
 $taskTarget = Join-Path $taskProduction $taskFile
 $taskText = [IO.File]::ReadAllText($taskSource)
 $taskOriginal = $taskText
 if ($taskFile.EndsWith('sandbox-admin-api.js')) {
  $taskOriginal = [regex]::Replace($taskText,'    function deleteAllRecords\(resource\) \{[\s\S]*?(?=    function deleteRecord\(resource\))','')
 } elseif ($taskFile.EndsWith('admin-sandbox.js')) {
  $taskOriginal = [regex]::Replace($taskText,'  document.addEventListener\(''click'', async event => \{\r?\n    const button = event.target.closest\(''\[data-delete-all-records\]''\);[\s\S]*?\r?\n  \}\);\r?\n\r?\n','')
 } else {
  $taskOriginal = [regex]::Replace($taskText,'<button type="button" class="button button-small button-danger" data-delete-all-records="(?:logs|events)">Delete all (?:logs|events)</button>','')
  $taskOriginal = $taskOriginal.Replace('20261105-admin5','20261105-admin4')
 }
 $taskLive = [IO.File]::ReadAllText($taskTarget)
 if ($taskOriginal.Replace("`r`n","`n") -ne $taskLive.Replace("`r`n","`n")) { throw "Production differs from expected baseline: $taskFile" }
}
foreach ($taskFile in $taskFiles) {
 $taskBackupFile = Join-Path $taskBackup $taskFile
 New-Item -ItemType Directory -Path (Split-Path -Parent $taskBackupFile) -Force | Out-Null
 Copy-Item -LiteralPath (Join-Path $taskProduction $taskFile) -Destination $taskBackupFile -Force
 Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination (Join-Path $taskProduction $taskFile) -Force
 if ((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskFile)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskProduction $taskFile)).Hash) { throw "Hash mismatch: $taskFile" }
}
Write-Output "Deployed and verified 3 files. Backup: $taskBackup"
