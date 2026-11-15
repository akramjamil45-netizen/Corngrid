$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$root='C:\CornGrid';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$result=@{phase='starting';hostname=[string]$env:COMPUTERNAME}
try{
 $result.packageAclBefore=[string](Get-Acl -LiteralPath 'C:\CornGrid\agent\package.json').AccessToString
 & icacls.exe $root '/inheritance:r' '/grant:r' ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to set the private installation root ACL.'}
 foreach($child in Get-ChildItem -LiteralPath $root -Force){
  if(-not $child.FullName.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected installation child path.'}
  & icacls.exe $child.FullName '/reset' '/T' '/C' '/Q'|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Unable to restore inheritance within the private installation.'}
 }
 $result.packageAclAfter=[string](Get-Acl -LiteralPath 'C:\CornGrid\agent\package.json').AccessToString
 $result.packageReadable=([IO.File]::ReadAllText('C:\CornGrid\agent\package.json')|ConvertFrom-Json).name -eq 'corngrid-sandbox-agent'
 $result.configReadable=([IO.File]::ReadAllText('C:\CornGrid\agent\agent-config.json')|ConvertFrom-Json).nodeUid -eq 'node_1677e8779f05aa567b'
 $result.phase='complete'
}catch{$result.phase='failed';$result.error=[string]$_.Exception.Message}
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-acl-result.json',($result|ConvertTo-Json -Compress))
