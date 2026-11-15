$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'website-incident-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Website incident inspection failed.'};exit
}
$result=[ordered]@{at=[DateTime]::UtcNow.ToString('o');requests=@();tunnelEvents=@();proxy=@()}
$logRoot='C:\inetpub\logs\LogFiles'
if(Test-Path -LiteralPath $logRoot){
 foreach($file in (Get-ChildItem -LiteralPath $logRoot -Filter ('u_ex'+[DateTime]::UtcNow.ToString('yyMMdd')+'.log') -Recurse -File)){
  $fieldLine=Get-Content -LiteralPath $file.FullName -TotalCount 8 | Where-Object {$_ -like '#Fields:*'} | Select-Object -Last 1
  if(-not $fieldLine){continue};$fields=$fieldLine.Substring(9).Split(' ')
  foreach($line in (Get-Content -LiteralPath $file.FullName -Tail 6000)){
   if($line.StartsWith('#')){continue};$parts=$line.Split(' ');if($parts.Count -ne $fields.Count){continue}
   $entry=@{};for($i=0;$i -lt $fields.Count;$i++){$entry[$fields[$i]]=$parts[$i]}
   if($entry['cs-uri-stem'] -match '/capacity$' -or [int]$entry['sc-status'] -ge 500 -or ([int]$entry['time-taken'] -gt 10000 -and $entry['cs-uri-stem'] -notmatch '/stream|^/ws/')){
    $result.requests+=@{date=$entry.date;time=$entry.time;path=$entry['cs-uri-stem'];method=$entry['cs-method'];status=$entry['sc-status'];subStatus=$entry['sc-substatus'];win32Status=$entry['sc-win32-status'];ms=$entry['time-taken']}
   }
  }
 }
}
$result.requests=@($result.requests | Select-Object -Last 80)
$events=Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='cloudflared';StartTime=(Get-Date).AddHours(-4)} -MaxEvents 20 -ErrorAction SilentlyContinue
foreach($event in $events){$message=$event.Message -replace '(?i)(token\s+|Bearer\s+)[^\s]+','$1[redacted]';$result.tunnelEvents+=@{at=$event.TimeCreated.ToString('o');id=$event.Id;summary=$message.Substring(0,[Math]::Min(800,$message.Length))}}
$appcmd='C:\Windows\System32\inetsrv\appcmd.exe'
if(Test-Path -LiteralPath $appcmd){$result.proxy=@(& $appcmd list config /section:system.webServer/proxy);$result.sites=@(& $appcmd list site);$result.apps=@(& $appcmd list vdir)}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $out -Encoding UTF8
