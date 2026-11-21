param([ValidateSet('InstallTest','DisableTest','StopTest','Production','Status')][string]$Phase='Status')
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Wrong VPS/account.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$root='C:\CornGridProxy';$setup='C:\CornGridProxySetup';$configFile=Join-Path $root 'private\proxy-config.json'
$plan=Get-Content -LiteralPath (Join-Path $workspace 'marketing\proxy-acceptance-plan.json') -Raw|ConvertFrom-Json
if(-not(Get-NetIPAddress -AddressFamily IPv4|Where-Object IPAddress -eq $plan.host)){throw 'Expected VPS public interface is missing.'}
$before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)
$result=[ordered]@{phase=$Phase;hostname=$env:COMPUTERNAME;at=[DateTime]::UtcNow.ToString('o');terminalPidsBefore=$before}
function Save { $result.terminalPidsAfter=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id);[IO.File]::WriteAllText((Join-Path $workspace ('marketing\proxy-vps-'+$Phase.ToLowerInvariant()+'-result.json')),($result|ConvertTo-Json -Depth 5)) }
function Stop-Acceptance {
 $scriptFile=Join-Path $setup 'proxy-acceptance-server.cjs'
 foreach($ownedProcess in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")){if($ownedProcess.CommandLine -and $ownedProcess.CommandLine.Contains($scriptFile)){Stop-Process -Id $ownedProcess.ProcessId -ErrorAction Stop}}
}
try{
 if($Phase -eq 'InstallTest'){
  if(Test-Path -LiteralPath $configFile){throw 'Proxy already installed; inspect before reinstalling.'}
  if(Test-Path -LiteralPath $setup){throw 'Setup directory already exists; inspect before retrying.'}
  $null=New-Item -ItemType Directory -Path $setup
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $setup /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Private setup ACL failed.'}
  $zip=Join-Path $setup 'CornGrid-Proxy-Server.zip';Copy-Item -LiteralPath (Join-Path $workspace 'CornGrid-Proxy-Server.zip') -Destination $zip
  if((Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant() -ne $plan.packageHash){throw 'Package hash mismatch.'}
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $setup 'package')
  Copy-Item -LiteralPath (Join-Path $workspace '.proxy-install-private\bootstrap-test.json') -Destination (Join-Path $setup 'bootstrap-test.json')
  $mainIp=(Get-Content -LiteralPath (Join-Path $workspace '.proxy-install-private\main-source-ip.txt') -Raw).Trim()
  & (Join-Path $setup 'package\Install-CornGridProxy.ps1') -BootstrapPath (Join-Path $setup 'bootstrap-test.json') -AllowedNodeAddresses @($mainIp) -NodeExe 'C:\Program Files\nodejs\node.exe'
  Disable-ScheduledTask -TaskName CornGridProxyServer|Out-Null;Stop-ScheduledTask -TaskName CornGridProxyServer
  $config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json;$config.maxConnections=128;$config.maxConnectionsPerSandbox=16
  $config|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $configFile -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $workspace 'marketing\proxy-acceptance-plan.json') -Destination (Join-Path $setup 'plan.json')
  Copy-Item -LiteralPath (Join-Path $workspace 'marketing\proxy-acceptance-server.cjs') -Destination (Join-Path $setup 'proxy-acceptance-server.cjs')
  [IO.File]::WriteAllText((Join-Path $setup 'acceptance-control.json'),'{"enabled":true}')
  $child=Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"'+(Join-Path $setup 'proxy-acceptance-server.cjs')+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $setup 'acceptance.out.log') -RedirectStandardError (Join-Path $setup 'acceptance.err.log')
  $result.acceptancePid=$child.Id;$result.certificateFingerprint=$config.certificateFingerprint
 }elseif($Phase -eq 'DisableTest'){
  [IO.File]::WriteAllText((Join-Path $setup 'acceptance-control.json'),'{"enabled":false}')
 }elseif($Phase -eq 'StopTest'){
  Stop-Acceptance;Stop-ScheduledTask -TaskName CornGridProxyServer
 }elseif($Phase -eq 'Production'){
  $bootstrap=Get-Content -LiteralPath (Join-Path $workspace '.proxy-install-private\bootstrap-production.json') -Raw|ConvertFrom-Json
  if($bootstrap.host -ne $plan.host -or $bootstrap.backendUrl -ne 'https://corngrid.com'){throw 'Production bootstrap target mismatch.'}
  $config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
  if($config.serverUid -ne $plan.serverUid -and ($config.serverUid -ne $bootstrap.serverUid -or $config.serverToken -ne $bootstrap.serverToken)){throw 'Identity differs; refusing to overwrite another production proxy.'}
  Stop-Acceptance;Stop-ScheduledTask -TaskName CornGridProxyServer
  $config.serverUid=$bootstrap.serverUid;$config.serverToken=$bootstrap.serverToken;$config.backendUrl=$bootstrap.backendUrl
  $config|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $configFile -Encoding UTF8
  @{serverUid=$bootstrap.serverUid;format=1;installedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'installation.json') -Encoding UTF8
  $allowed=@(Get-Content -LiteralPath (Join-Path $workspace '.proxy-install-private\allowed-node-addresses.json') -Raw|ConvertFrom-Json)
  if(-not $allowed.Count -or ($allowed|Where-Object{$_ -notmatch '^\d{1,3}(\.\d{1,3}){3}$'})){throw 'Expected concrete IPv4 firewall sources.'}
  Set-NetFirewallRule -Name CornGridProxyTLS -RemoteAddress $allowed
  Enable-ScheduledTask -TaskName CornGridProxyServer|Out-Null;Start-ScheduledTask -TaskName CornGridProxyServer
  $result.productionDaemonStarted=$true
 }
 if(Test-Path -LiteralPath $configFile){$publicConfig=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json;$result.certificateFingerprint=$publicConfig.certificateFingerprint;$result.serverUid=$publicConfig.serverUid}
 $result.listening=@(Get-NetTCPConnection -State Listen -LocalPort $plan.port -ErrorAction SilentlyContinue).Count -gt 0
 $result.taskState=[string](Get-ScheduledTask -TaskName CornGridProxyServer -ErrorAction SilentlyContinue).State
 $result.success=$true;Save
}catch{$result.success=$false;$result.error=$_.Exception.Message;Save;throw}
