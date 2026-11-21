$ErrorActionPreference='Stop'
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$os=Get-CimInstance Win32_OperatingSystem
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$result=[ordered]@{hostname=$env:COMPUTERNAME;user=$env:USERNAME;os=$os.Caption;build=$os.BuildNumber;administrator=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);ramMb=[math]::Round($os.TotalVisibleMemorySize/1024);freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);diskFreeMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB);localIPv4=@(Get-NetIPAddress -AddressFamily IPv4|Where-Object AddressState -eq Preferred|Select-Object -ExpandProperty IPAddress);nodePresent=(Test-Path 'C:\Program Files\nodejs\node.exe');proxyInstalled=(Test-Path 'C:\CornGridProxy\installation.json');tasks=@(Get-ScheduledTask -TaskName '*CornGrid*' -ErrorAction SilentlyContinue|Select-Object TaskName,State);terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue|Select-Object Id,Path);redirectedDriveAvailable=(Test-Path -LiteralPath $workspace)}
if($result.nodePresent){$result.nodeVersion=(& 'C:\Program Files\nodejs\node.exe' --version)-join ''}
$json=$result|ConvertTo-Json -Depth 5
if($result.redirectedDriveAvailable){[IO.File]::WriteAllText((Join-Path $workspace 'marketing\proxy-vps-audit-result.json'),$json)}
Set-Clipboard -Value ('CORNGRID_REMOTE_RESULT:'+$json)
Write-Output $json
