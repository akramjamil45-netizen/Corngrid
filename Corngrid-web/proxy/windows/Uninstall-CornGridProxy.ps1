[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$InstallRoot='C:\CornGridProxy')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot);$marker=Join-Path $root 'installation.json'
if(-not(Test-Path -LiteralPath $marker)){throw 'No CornGrid proxy ownership marker found.'}
$config=Get-Content -LiteralPath (Join-Path $root 'private\proxy-config.json') -Raw|ConvertFrom-Json
if($config.serverUid -ne (Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json).serverUid){throw 'Proxy identity mismatch.'}
$task=Get-ScheduledTask -TaskName CornGridProxyServer -ErrorAction SilentlyContinue
if($task -and ([string]$task.Actions[0].Arguments).IndexOf((Join-Path $root 'Run-Proxy.ps1'),[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'The scheduled task belongs to another installation.'}
if($PSCmdlet.ShouldProcess($root,'Stop the proxy and remove its task/firewall rule; preserve private files')){
 if($task){Stop-ScheduledTask -TaskName CornGridProxyServer -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName CornGridProxyServer -Confirm:$false}
 $serverPath=Join-Path $root 'proxy\server.js';$configPath=Join-Path $root 'private\proxy-config.json'
 foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")){
  if($process.CommandLine -and $process.CommandLine.Contains($serverPath) -and $process.CommandLine.Contains($configPath)){Stop-Process -Id $process.ProcessId -ErrorAction Stop}
 }
 $rule=Get-NetFirewallRule -Name CornGridProxyTLS -ErrorAction SilentlyContinue
 if($rule){$port=$rule|Get-NetFirewallPortFilter;if([string]$port.LocalPort -eq [string]$config.port){$rule|Remove-NetFirewallRule}else{throw 'Firewall port differs; the rule was preserved for review.'}}
 Write-Host 'Proxy task and firewall rule removed. Installation files and TLS identity were retained for recovery.'
}
