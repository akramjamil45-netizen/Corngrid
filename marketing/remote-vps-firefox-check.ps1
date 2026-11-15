$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$out='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-vps-storage-verify-result.json'
$result=@{phase='firefox-uninstall-check';hostname=[string]$env:COMPUTERNAME}
$result.signatures=@();foreach($path in @('C:\Program Files (x86)\Mozilla Maintenance Service\uninstall.exe','C:\Program Files (x86)\Mozilla Maintenance Service\maintenanceservice.exe')){
 if(Test-Path -LiteralPath $path){$signature=Get-AuthenticodeSignature -LiteralPath $path;$result.signatures+=@{path=$path;status=[string]$signature.Status;signer=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null}}}
}
$result.mozillaServices=@(Get-CimInstance Win32_Service|Where-Object{$_.Name -like '*Mozilla*'}|ForEach-Object{@{name=$_.Name;state=$_.State;path=$_.PathName}})
$result.firefoxFolderExists=Test-Path -LiteralPath 'C:\Program Files\Mozilla Firefox'
$result.mozillaPrograms=@();foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')){
 $result.mozillaPrograms+=@(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue|Where-Object{$_.Publisher -like '*Mozilla*'}|ForEach-Object{@{name=$_.DisplayName;uninstall=$_.UninstallString}})
}
$result.freeDiskMb=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB)
[IO.File]::WriteAllText($out,($result|ConvertTo-Json -Depth 6 -Compress))
