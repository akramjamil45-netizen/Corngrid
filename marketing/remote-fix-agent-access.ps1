$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User.Value
$root='C:\CornGrid';$file='C:\CornGrid\agent\agent-config.json'
$result=@{hostname=[string]$env:COMPUTERNAME;sid=[string]$sid;isAdmin=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
try{
 $result.originalAttributes=[string](Get-Item -LiteralPath $file -Force).Attributes
 $result.originalOwner=[string](Get-Acl -LiteralPath $file).Owner
 & icacls.exe $root '/grant:r' ('*'+$sid+':(OI)(CI)F') '/T' '/Q' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to grant the task account access.'}
 & icacls.exe $file '/grant:r' ('*'+$sid+':F') '*S-1-5-18:F' '*S-1-5-32-544:F' '/Q'|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Unable to secure the node config file.'}
 $contents=[IO.File]::ReadAllText($file)|ConvertFrom-Json
 $result.configReadable=$contents.nodeUid -eq 'node_1677e8779f05aa567b'
 $result.phase='complete'
}catch{$result.phase='failed';$result.error=[string]$_.Exception.Message}
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-access-result.json',($result|ConvertTo-Json -Compress))
