[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$BootstrapPath,
 [Parameter(Mandatory=$true)][string[]]$AllowedNodeAddresses,
 [string]$InstallRoot='C:\CornGridProxy',
 [string]$NodeExe=''
)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run PowerShell as Administrator.'}
if(-not[Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required.'}
if([int](Get-CimInstance Win32_OperatingSystem).BuildNumber -lt 17763){throw 'Use Windows Server 2019 or newer (Windows build 17763+).'}
$bootstrap=Get-Content -LiteralPath $BootstrapPath -Raw|ConvertFrom-Json
if($bootstrap.format -ne 1 -or $bootstrap.serverUid -notmatch '^cgp_[a-f0-9]{18}$' -or $bootstrap.serverToken -notmatch '^cgpx_[a-f0-9]{64}$'){throw 'Invalid bootstrap JSON. Export it from CornGrid Admin.'}
$backendUri=[uri]$bootstrap.backendUrl
if($backendUri.Scheme -ne 'https' -or $backendUri.UserInfo -or $backendUri.Query -or $backendUri.Fragment){throw 'The bootstrap backend must be a trusted HTTPS origin.'}
if($bootstrap.port -lt 1 -or $bootstrap.port -gt 65535){throw 'Invalid proxy port.'}
foreach($address in $AllowedNodeAddresses){if($address -notmatch '^(Any|LocalSubnet|[0-9a-fA-F:.]+(?:/\d{1,3})?)$'){throw 'Firewall sources must be IPs/CIDRs, LocalSubnet or explicitly Any.'}}
$root=[IO.Path]::GetFullPath($InstallRoot)
if($root -eq [IO.Path]::GetPathRoot($root) -or $root.StartsWith($env:SystemRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Choose a dedicated installation directory.'}
if(Test-Path -LiteralPath $root){if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installation directory cannot be a junction or symlink.'};$marker=Join-Path $root 'installation.json';if((Get-ChildItem -LiteralPath $root -Force|Measure-Object).Count -and -not(Test-Path -LiteralPath $marker)){throw 'The existing directory is not owned by this installer.'};if(Test-Path -LiteralPath $marker){if((Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json).serverUid -ne $bootstrap.serverUid){throw 'Existing installation belongs to another proxy.'}}}
$taskName='CornGridProxyServer'
$oldTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($oldTask){throw 'An existing proxy task is registered. Use the documented maintenance procedure before reinstalling.'}
$packageRoot=$PSScriptRoot
if(-not(Test-Path -LiteralPath (Join-Path $packageRoot 'proxy\server.js'))){$packageRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))}
$sources=@('proxy\server.js','proxy\control-client.js','agent\proxy-protocol.js')
foreach($file in $sources){if(-not(Test-Path -LiteralPath (Join-Path $packageRoot $file))){throw ('Package file missing: '+$file)}}
$manifestPath=Join-Path $packageRoot 'MANIFEST.json'
if(Test-Path -LiteralPath $manifestPath){
 $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
 foreach($file in $sources){
  $entry=@($manifest.files|Where-Object{$_.path -eq $file.Replace('\','/')})
  if($entry.Count -ne 1 -or $entry[0].sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $packageRoot $file) -Algorithm SHA256).Hash -ine $entry[0].sha256){throw ('Package integrity check failed: '+$file)}
 }
}
$null=New-Item -ItemType Directory -Path $root -Force
& icacls.exe $root /inheritance:r /grant:r ('*'+$identity.User.Value+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q|Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect the installation directory.'}
@{serverUid=$bootstrap.serverUid;installedAt=[DateTime]::UtcNow.ToString('o');format=1}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'installation.json') -Encoding UTF8
foreach($folder in @('runtime','logs','private','proxy','agent')){$null=New-Item -ItemType Directory -Path (Join-Path $root $folder) -Force}
foreach($file in $sources){Copy-Item -LiteralPath (Join-Path $packageRoot $file) -Destination (Join-Path $root $file) -Force}
if(-not $NodeExe){
 $version='24.20.0';$archive='node-v'+$version+'-win-x64.zip';$base='https://nodejs.org/dist/v'+$version+'/'
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $checksums=(Invoke-WebRequest -UseBasicParsing -Uri ($base+'SHASUMS256.txt') -TimeoutSec 60).Content
 $line=($checksums -split "`n"|Where-Object{$_ -match ('^[a-f0-9]{64}\s+'+[regex]::Escape($archive)+'\s*$')}|Select-Object -First 1)
 if(-not $line){throw 'Node archive checksum was not found on the official release endpoint.'}
 $zip=Join-Path $root ('runtime\'+$archive)
 Invoke-WebRequest -UseBasicParsing -Uri ($base+$archive) -OutFile $zip -TimeoutSec 300
 if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine ($line -split '\s+')[0]){throw 'Node archive integrity check failed.'}
 Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $root 'runtime') -Force
 $NodeExe=Join-Path $root ('runtime\node-v'+$version+'-win-x64\node.exe')
}
$NodeExe=[IO.Path]::GetFullPath($NodeExe)
$nodeVersion=(& $NodeExe --version)-join ''
if($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(?:2[4-9]|[3-9][0-9])\.'){throw 'A working Node.js 24+ runtime is required.'}
$private=Join-Path $root 'private';$pfx=Join-Path $private 'proxy.pfx';$configPath=Join-Path $private 'proxy-config.json'
if(Test-Path -LiteralPath $pfx){
 if(-not(Test-Path -LiteralPath $configPath)){throw 'Existing PFX has no matching private configuration. Restore the private backup before reinstalling.'}
 $previous=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
 if($previous.serverUid -ne $bootstrap.serverUid -or $previous.serverToken -ne $bootstrap.serverToken){throw 'Existing TLS identity belongs to a different proxy bootstrap.'}
 $pfxPassword=$previous.pfxPassphrase;$fingerprint=$previous.certificateFingerprint
}else{
 $random=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($random)}finally{$rng.Dispose()};$pfxPassword=[Convert]::ToBase64String($random)
 $cert=New-SelfSignedCertificate -DnsName ([string]$bootstrap.host) -CertStoreLocation 'Cert:\LocalMachine\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
 $null=Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pfxPassword -AsPlainText -Force)
 $sha=[Security.Cryptography.SHA256]::Create();try{$fingerprint=([BitConverter]::ToString($sha.ComputeHash($cert.RawData))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
$config=@{format=1;backendUrl=$bootstrap.backendUrl.TrimEnd('/');serverUid=$bootstrap.serverUid;serverToken=$bootstrap.serverToken;port=[int]$bootstrap.port;listenHost='0.0.0.0';pfxPath=$pfx;pfxPassphrase=$pfxPassword;certificateFingerprint=$fingerprint;maxConnections=500;maxConnectionsPerSandbox=32}
$config|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $configPath -Encoding UTF8
# Tokens and PFX passphrases live only in ACL-protected files, never arguments.
$launcher=Join-Path $root 'Run-Proxy.ps1'
$quote={param($value) "'"+$value.Replace("'","''")+"'"}
$launchText='$ErrorActionPreference=''Stop''' + "`r`n" + '& '+(& $quote $NodeExe)+' '+(& $quote (Join-Path $root 'proxy\server.js'))+' '+(& $quote $configPath)+' 1>> '+(& $quote (Join-Path $root 'logs\proxy-output.log'))+' 2>> '+(& $quote (Join-Path $root 'logs\proxy-error.log'))+"`r`n"+'exit $LASTEXITCODE'
[IO.File]::WriteAllText($launcher,$launchText,[Text.UTF8Encoding]::new($false))
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'"') -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtStartup
$recovery=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger,$recovery) -Settings $settings -Principal $principal
$null=New-NetFirewallRule -Name 'CornGridProxyTLS' -DisplayName 'CornGrid Proxy TLS from sandbox nodes' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $bootstrap.port -RemoteAddress $AllowedNodeAddresses -Profile Any
Start-ScheduledTask -TaskName $taskName
Write-Host ('Installed '+$taskName+' using '+$nodeVersion+'. The proxy remains disabled until enabled in CornGrid Admin.')
Write-Host 'Next: add public/source IPs in Proxy Servers, refresh until verified, then enable and assign nodes.'
Write-Host ('TLS fingerprint: '+$fingerprint)
Write-Host ('Private configuration: '+$configPath+'. Do not share its contents.')
