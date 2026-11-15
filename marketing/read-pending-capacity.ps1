$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'pending-capacity-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Pending request inspection failed.'};exit
}
$raw=& 'C:\Windows\System32\inetsrv\appcmd.exe' list requests /xml
$xml=[xml]($raw -join "`n")
$report=@{at=[DateTime]::UtcNow.ToString('o');requests=@()}
$report.counters=@()
try{foreach($sample in (Get-Counter '\HTTP Service Request Queues(*)\CurrentQueueSize','\HTTP Service Request Queues(*)\RejectedRequests','\HTTP Service Request Queues(*)\MaxQueueItemAge','\Web Service(*)\Current Connections' -ErrorAction Stop).CounterSamples){$report.counters+=@{path=$sample.Path;value=$sample.CookedValue}}}catch{$report.counterError=$_.Exception.Message}
foreach($entry in $xml.appcmd.REQUEST){
 $report.requests+=@{url=([string]$entry.url -replace '\?.*$','');verb=[string]$entry.verb;elapsed=[string]$entry.timeElapsed;stage=[string]$entry.stage;module=[string]$entry.moduleName;site=[string]$entry.'SITE.ID'}
}
$report|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $out -Encoding UTF8
