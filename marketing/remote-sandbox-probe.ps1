$ErrorActionPreference='Stop'
try {
 $system=Get-CimInstance Win32_ComputerSystem
 $os=Get-CimInstance Win32_OperatingSystem
 $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
 $disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{drive=$_.DeviceID;sizeGb=[math]::Round($_.Size/1GB,1);freeGb=[math]::Round($_.FreeSpace/1GB,1)} })
 $node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
 $pythonCommands=@(Get-Command python.exe,py.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
 $pythonFiles=@(Get-ChildItem -Path "$env:LOCALAPPDATA\Programs\Python\*\python.exe",'C:\Python*\python.exe','C:\Program Files\Python*\python.exe' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
 $programs=@(Get-ChildItem -LiteralPath $env:ProgramFiles -Directory | Where-Object { $_.Name -match 'MetaTrader|RoboForex|LiteFinance|Terminal|Python|nodejs' } | Select-Object -ExpandProperty FullName)
 $terminals=@(Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object Id,Path,SessionId,@{Name='memoryMb';Expression={[math]::Round($_.WorkingSet64/1MB)}})
 $tasks=@(Get-ScheduledTask -TaskName '*CornGrid*' -ErrorAction SilentlyContinue | Select-Object TaskName,State)
 $folders=@(Get-ChildItem -LiteralPath C:\ -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CornGrid|Sandbox|MetaTrader|Python|MT5' } | Select-Object -ExpandProperty FullName)
 $redirected='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
 $health=$false;try{$health=(Invoke-RestMethod -Uri 'https://corngrid.com/api/health' -TimeoutSec 15).status -eq 'ok'}catch{}
 $result=[ordered]@{hostname=$env:COMPUTERNAME;user=$env:USERNAME;os=$os.Caption;ramMb=[math]::Round($system.TotalPhysicalMemory/1MB);freeRamMb=[math]::Round($os.FreePhysicalMemory/1024);cpuCount=$system.NumberOfLogicalProcessors;diskGb=[math]::Round($disk.Size/1GB,1);diskFreeGb=[math]::Round($disk.FreeSpace/1GB,1);disks=$disks;nodeVersion=$(if(Test-Path -LiteralPath $node){& $node --version}else{$null});pythonCommands=$pythonCommands;pythonFiles=$pythonFiles;programs=$programs;terminals=$terminals;tasks=$tasks;folders=$folders;redirectedDriveAvailable=(Test-Path -LiteralPath $redirected);backendHealth=$health}
 $json=$result|ConvertTo-Json -Compress -Depth 5
 Set-Clipboard -Value ('CORNGRID_REMOTE_RESULT:'+$json)
 [IO.File]::WriteAllText((Join-Path $redirected 'marketing\remote-sandbox-result.json'),$json)
 Write-Output $json
}catch{$json=@{error=$_.Exception.Message}|ConvertTo-Json -Compress;Set-Clipboard -Value ('CORNGRID_REMOTE_RESULT:'+$json);Write-Output $json}
