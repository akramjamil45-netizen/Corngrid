param([string]$ProjectDir = 'C:\Website\Website\Corngrid-web', [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ProjectDir "' + $ProjectDir + '" -Port ' + $Port
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
    Write-Host "Administrator installer launched (PID $($elevated.Id)). See service\install-result.json."
    exit 0
}
$serviceDir = Join-Path $ProjectDir 'service'
$resultPath = Join-Path $serviceDir 'install-result.json'
Start-Transcript -Path (Join-Path $serviceDir 'install.log') -Append | Out-Null
try {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $backendProcessId = 0
    if ($listeners.Count) { $backendProcessId = $listeners[0].OwningProcess }
    & (Join-Path $serviceDir 'install.ps1') -ProjectDir $ProjectDir -Port $Port -ExistingProcessId $backendProcessId
    @{ success = $true; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $resultPath
} catch {
    @{ success = $false; error = $_.Exception.Message; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $resultPath
    throw
} finally { Stop-Transcript | Out-Null }
