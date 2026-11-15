$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$path='C:\Program Files (x86)\RoboForex - MetaTrader 4\uninstall.exe'
$signature=Get-AuthenticodeSignature -LiteralPath $path
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'MetaQuotes'){throw 'Unexpected MT4 uninstaller signature.'}
if(@(Get-Process terminal -ErrorAction SilentlyContinue).Count){throw 'MT4 is running; review before removal.'}
# The interactive uninstaller lets us preserve the personal-data checkbox.
Start-Process -FilePath $path -PassThru|Select-Object Id,ProcessName
