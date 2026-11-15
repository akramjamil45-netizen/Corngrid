param([ValidateSet('Prepare','Finish')][string]$Phase='Prepare')
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Phase '+$Phase) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Elevated local bootstrap failed.'};exit
}
& (Join-Path $PSScriptRoot 'bootstrap-node-auto-update.ps1') -Phase $Phase -AgentDir 'C:\Website\Website\Corngrid-web\agent' -SourceAgentDir 'C:\Website\Website\Corngrid-web\agent' -ExpectedHost WINSLET -ExpectedNodeUid 'node_00131382007cf3e46a'
