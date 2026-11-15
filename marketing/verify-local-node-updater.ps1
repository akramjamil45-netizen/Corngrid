param([ValidateSet('Baseline','Final')][string]$Mode='Final')
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Mode '+$Mode) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Elevated verification failed.'};exit
}
& (Join-Path $PSScriptRoot 'verify-node-auto-update.ps1') -AgentDir 'C:\Website\Website\Corngrid-web\agent' -ExpectedHost WINSLET -Mode $Mode
