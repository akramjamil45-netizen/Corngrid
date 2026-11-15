$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS80481'){throw 'Wrong target host.'}
$stopped=@()
foreach($process in Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"){
 if($process.ProcessId -eq $PID){continue}
 $match=[regex]::Match([string]$process.CommandLine,'(?i)-EncodedCommand\s+"?([A-Za-z0-9+/=]+)')
 if(-not $match.Success){continue}
 try{$decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($match.Groups[1].Value))}catch{continue}
 if($decoded.IndexOf('remote-sandbox-configure.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $decoded.IndexOf('configure-node.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0){
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  $stopped+=$process.ProcessId
 }
}
$result=@{stoppedOwnedConfigurationHelpers=$stopped;freeRamMb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)}
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\remote-sandbox-recovery-result.json',($result|ConvertTo-Json -Compress))
Write-Output 'Owned configuration helpers stopped.'
