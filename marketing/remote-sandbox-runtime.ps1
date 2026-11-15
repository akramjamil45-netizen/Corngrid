param([switch]$LegacyCpu)
$ErrorActionPreference='Stop'
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$resultFile=Join-Path $workspace 'marketing\remote-sandbox-runtime-result.json'
$result=[ordered]@{hostname=$env:COMPUTERNAME;phase='starting';hostingCapacity=2;agentStarted=$false}
function Save-Result { [IO.File]::WriteAllText($resultFile,($result|ConvertTo-Json -Compress -Depth 6)) }
try{
 if($env:COMPUTERNAME -ne 'VPS80481' -or $env:USERNAME -ne 'Administrator'){throw 'Unexpected target host/account.'}
 $root='C:\CornGrid';$agent=Join-Path $root 'agent';$base=Join-Path $root 'Sandbox\MT5'
 if(-not(Test-Path -LiteralPath (Join-Path $agent 'agent.js')) -or (Test-Path -LiteralPath (Join-Path $agent 'agent-config.json'))){throw 'Agent staging state was not expected.'}
 Save-Result
 $result.phase='installing-python-broker-tools';Save-Result
 $python='C:\Program Files\Python312\python.exe'
 if($LegacyCpu){
  $failedTools=[IO.Path]::GetFullPath((Join-Path $agent 'broker-python'))
  if($failedTools -ne 'C:\CornGrid\agent\broker-python' -or -not $failedTools.StartsWith($agent+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected broker tool path.'}
  if(Test-Path -LiteralPath $failedTools){Remove-Item -LiteralPath $failedTools -Recurse -Force}
 }
 $ErrorActionPreference='Continue'
 if($LegacyCpu){& $python -m pip install --disable-pip-version-check --no-cache-dir --target (Join-Path $agent 'broker-python') 'MetaTrader5>=5.0,<6' 'numpy<2.4' *> (Join-Path $root 'python-tools-install.log')}
 else{& $python -m pip install --disable-pip-version-check --no-cache-dir --target (Join-Path $agent 'broker-python') 'MetaTrader5>=5.0,<6' *> (Join-Path $root 'python-tools-install.log')}
 $pipExit=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($pipExit -ne 0){throw 'Python broker tools installation failed. See C:\CornGrid\python-tools-install.log.'}
 $pythonProbe="import sys,struct,json;sys.path.insert(0,r'C:\CornGrid\agent\broker-python');import MetaTrader5 as m;import numpy;print(json.dumps(dict(version=m.__version__,numpyVersion=numpy.__version__,bits=struct.calcsize('P')*8)))"
 $result.pythonBrokerTools=(& $python -c $pythonProbe)|ConvertFrom-Json
 if($LASTEXITCODE -ne 0 -or $result.pythonBrokerTools.bits -ne 64){throw 'Python broker tool validation failed.'}
 $result.phase='preparing-clean-mt5-runtime';Save-Result
 $source='C:\Program Files\RoboForex MT5 Terminal'
 if(@(Get-ChildItem -LiteralPath $base -Force).Count){throw 'The new MT5 base directory is not empty.'}
 # Hosting nodes do not compile/test code; keep the full runtime tree but omit developer/installer executables.
 $excludedDirectories=@('config','profiles','logs','bases','tester','reports','history')
 $excludedFiles=@('MetaEditor64.exe','metatester64.exe','uninstall.exe','origin.txt')
 foreach($item in Get-ChildItem -LiteralPath $source -Force){
  if($item.PSIsContainer){if($excludedDirectories -contains $item.Name.ToLowerInvariant()){continue};Copy-Item -LiteralPath $item.FullName -Destination $base -Recurse}
  elseif($excludedFiles -notcontains $item.Name){Copy-Item -LiteralPath $item.FullName -Destination $base}
 }
 $signature=Get-AuthenticodeSignature -LiteralPath (Join-Path $base 'terminal64.exe')
 if($signature.Status -ne 'Valid'){throw 'The MT5 terminal digital signature is not valid.'}
 $result.mt5Signer=$signature.SignerCertificate.Subject
 $result.mt5BaseSizeMb=[math]::Round((Get-ChildItem -LiteralPath $base -Recurse -File | Measure-Object Length -Sum).Sum/1MB)
 # Retain only the allowed WebRequest settings under this VPS Windows account; never copy account databases or passwords.
 $webRequest=@();$profileFound=$false
 $profilesRoot=Join-Path $env:APPDATA 'MetaQuotes\Terminal'
 foreach($profile in Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue){
  $origin=Join-Path $profile.FullName 'origin.txt';$ini=Join-Path $profile.FullName 'config\common.ini'
  if(-not(Test-Path -LiteralPath $origin) -or -not(Test-Path -LiteralPath $ini)){continue}
  if(([IO.File]::ReadAllText($origin)).Trim() -ne $source){continue}
  $profileFound=$true;$bytes=[IO.File]::ReadAllBytes($ini);$encoding=if($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254){[Text.Encoding]::Unicode}else{[Text.Encoding]::UTF8}
  $text=$encoding.GetString($bytes);$section=[regex]::Match($text,'(?s)\[Experts\](.*?)(?=\r?\n\[|$)').Groups[1].Value
  $webRequest=@($section -split '\r?\n' | Where-Object { $_ -match '^WebRequest(?:Url)?=' })
  if(@($webRequest | Where-Object { $_ -match '^WebRequestUrl=.+' }).Count){break}
 }
 $result.existingWebRequestTemplateAvailable=@($webRequest | Where-Object { $_ -match '^WebRequestUrl=.+' }).Count -gt 0
 if($result.existingWebRequestTemplateAvailable){
  $settings=Join-Path $root 'Sandbox\WebRequest';New-Item -ItemType Directory -Path $settings -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $settings 'common.ini'),('[Experts]'+"`r`n"+($webRequest -join "`r`n")+"`r`n"),[Text.Encoding]::Unicode)
 }
 $result.baseHasNoAccountDatabase=-not(Test-Path -LiteralPath (Join-Path $base 'config\accounts.dat'))
 $result.phase='runtime-prepared';$result.freeDiskMb=[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace/1MB);Save-Result
 Write-Output 'Hosting runtime and broker tools prepared. No sandbox or agent has been started.'
}catch{$result.phase='failed';$result.error=$_.Exception.Message;Save-Result;Write-Error $_}
