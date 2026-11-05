param(
    [string]$ProjectDir = 'C:\Website\Website\Corngrid-web',
    [int]$ExistingProcessId = 0,
    [int]$Port = 3000
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer from PowerShell as Administrator.'
}
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$serviceDir = Join-Path $ProjectDir 'service'
$wrapper = Join-Path $serviceDir 'CornGridWeb.exe'
$config = Join-Path $serviceDir 'CornGridWeb.xml'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$serverScript = Join-Path $ProjectDir 'server.js'
foreach ($required in @($serverScript, (Join-Path $ProjectDir '.env'), (Join-Path $ProjectDir 'node_modules'), $wrapper)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required path: $required" }
}
$expectedHash = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'
if ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'WinSW checksum mismatch. Restore the supplied WinSW v2.12.0 binary.'
}
$existingService = Get-CimInstance Win32_Service -Filter "Name = 'CornGridWeb'"
if ($existingService -and $existingService.PathName.Trim('"') -ne $wrapper) {
    throw 'CornGridWeb already belongs to another installation. No changes made.'
}
if ($existingService -and $existingService.State -eq 'Running') {
    Write-Host 'CornGridWeb is already running. Use Restart-Service CornGridWeb after code updates.'
    exit 0
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($listeners.Count) {
    if ($ExistingProcessId -lt 1 -or @($listeners | Where-Object { $_.OwningProcess -ne $ExistingProcessId }).Count) {
        throw "Port $Port is occupied. Specify the verified CornGrid PID using -ExistingProcessId."
    }
    $previous = Get-CimInstance Win32_Process -Filter "ProcessId = $ExistingProcessId"
    if ($previous.ExecutablePath -ne $nodeExe -or $previous.CommandLine -notmatch '(?:^|[\s"\\])server\.js(?:[\s"]|$)') {
        throw 'The supplied PID is not a matching Node server.js process.'
    }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 8
    if ($health.status -ne 'ok' -or $health.service -ne 'auth') { throw 'Existing backend health did not match.' }
}
New-Item -ItemType Directory -Path (Join-Path $serviceDir 'logs') -Force | Out-Null
function Escape-Xml([string]$value) { [Security.SecurityElement]::Escape($value) }
$nodeXml = Escape-Xml $nodeExe
$projectXml = Escape-Xml $ProjectDir
$scriptXml = Escape-Xml $serverScript
$serviceXml = @"
<service>
  <id>CornGridWeb</id>
  <name>CornGrid Web Server</name>
  <description>CornGrid Express backend, API and sandbox WebSocket hub.</description>
  <executable>$nodeXml</executable>
  <arguments>&quot;$scriptXml&quot;</arguments>
  <workingdirectory>$projectXml</workingdirectory>
  <env name="PORT" value="$Port" />
  <startmode>Automatic</startmode>
  <delayedAutoStart />
  <depend>Tcpip</depend>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <logpath>%BASE%\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
[xml]$validated = $serviceXml
[IO.File]::WriteAllText($config, $validated.OuterXml, (New-Object Text.UTF8Encoding($false)))
# Install before stopping the healthy backend, so denied installation leaves it up.
if (-not $existingService) {
    & $wrapper install
    if ($LASTEXITCODE -ne 0) { throw "Service install failed: $LASTEXITCODE" }
}
$stoppedPrevious = $false
try {
    if ($listeners.Count) {
        Stop-Process -Id $ExistingProcessId -ErrorAction Stop
        $stoppedPrevious = $true
        Wait-Process -Id $ExistingProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
    Start-Service -Name CornGridWeb
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($health.status -eq 'ok' -and (Get-Service CornGridWeb).Status -eq 'Running') {
                $healthy = $true
                break
            }
        } catch { }
    }
    if (-not $healthy) { throw 'Service health check failed. Check service\logs.' }
    Get-CimInstance Win32_Service -Filter "Name = 'CornGridWeb'" | Select-Object Name,State,StartMode,ProcessId
    Write-Host "CornGridWeb installed and healthy on port $Port."
} catch {
    Stop-Service CornGridWeb -ErrorAction SilentlyContinue
    if ($stoppedPrevious) {
        Start-Process -FilePath $nodeExe -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $ProjectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $serviceDir 'logs\fallback.out.log') -RedirectStandardError (Join-Path $serviceDir 'logs\fallback.err.log')
        Write-Warning 'Restored the backend as a normal process because service startup failed.'
    }
    throw
}
