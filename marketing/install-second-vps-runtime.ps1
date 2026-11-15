$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne 'VPS81258'){throw 'Wrong VPS.'}
$workspace='\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website'
$out=Join-Path $workspace 'marketing\second-vps-runtime-result.json';$r=[ordered]@{phase='starting';hostname=$env:COMPUTERNAME}
function Save {[IO.File]::WriteAllText($out,($r|ConvertTo-Json -Compress -Depth 5))}
try{
 $prepared=Get-Content (Join-Path $workspace 'marketing\second-vps-prepare-result.json') -Raw|ConvertFrom-Json
 if($prepared.phase -ne 'agent-files-staged'){throw 'Agent staging is incomplete.'}
 $cache=Join-Path $workspace 'marketing\second-vps-install-cache';$hashes=Get-Content (Join-Path $cache 'hashes.json') -Raw|ConvertFrom-Json
 $temp='C:\CornGrid\InstallTemp';New-Item -ItemType Directory -Path $temp -Force|Out-Null
 [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
 $r.phase='installing-node';Save
 if(-not(Test-Path 'C:\Program Files\nodejs\node.exe')){
  $zip=Join-Path $temp 'node.zip'
  if(-not(Test-Path $zip) -or (Get-FileHash $zip).Hash -ne $hashes.nodeHash){$download=New-Object Net.WebClient;try{$download.DownloadFile('https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip',$zip)}finally{$download.Dispose()}}
  if((Get-FileHash (Join-Path $temp 'node.zip')).Hash -ne $hashes.nodeHash){throw 'Node checksum mismatch.'}
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $partial=[IO.Path]::GetFullPath((Join-Path $temp 'node-v24.20.0-win-x64'))
  if(-not $partial.StartsWith($temp+'\') -or (Split-Path -Leaf $partial) -ne 'node-v24.20.0-win-x64'){throw 'Unsafe extraction path.'}
  if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial -Recurse -Force}
  [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $temp 'node.zip'),$temp)
  $from=[IO.Path]::GetFullPath((Join-Path $temp 'node-v24.20.0-win-x64'));$to='C:\Program Files\nodejs'
  if(-not $from.StartsWith($temp+'\') -or (Test-Path -LiteralPath $to)){throw 'Unexpected Node installation path.'}
  Move-Item -LiteralPath $from -Destination $to
 }
 $env:PATH='C:\Program Files\nodejs;'+$env:PATH;$r.nodeVersion=[string](& 'C:\Program Files\nodejs\node.exe' --version)
 $r.phase='installing-python';Save
 if(-not(Test-Path 'C:\Program Files\Python313\python.exe')){
  $download=New-Object Net.WebClient;try{$download.DownloadFile('https://www.python.org/ftp/python/3.13.9/python-3.13.9-amd64.exe',(Join-Path $temp 'python.exe'))}finally{$download.Dispose()}
  if((Get-FileHash (Join-Path $temp 'python.exe')).Hash -ne $hashes.pythonHash){throw 'Python checksum mismatch.'}
  $installer=Start-Process -FilePath (Join-Path $temp 'python.exe') -ArgumentList '/quiet InstallAllUsers=1 TargetDir="C:\Program Files\Python313" PrependPath=1 Include_test=0 Include_doc=0 Include_launcher=0 Include_tcltk=0 Include_pip=1' -WindowStyle Hidden -Wait -PassThru
  if($installer.ExitCode -notin @(0,3010)){throw ('Python installer failed: '+$installer.ExitCode)}
 }
 $python='C:\Program Files\Python313\python.exe';$r.pythonVersion=[string](& $python --version)
 $r.phase='installing-agent-dependencies';Save
 $modules='C:\CornGrid\agent\node_modules';New-Item -ItemType Directory -Path $modules -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $workspace 'Corngrid-web\agent\node_modules\ws') -Destination $modules -Recurse -Force
 $r.phase='installing-broker-tools';Save
 $ErrorActionPreference='Continue';& $python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --target 'C:\CornGrid\agent\broker-python' 'MetaTrader5>=5.0,<6' 'numpy<2.4' *> 'C:\CornGrid\python-tools-install.log';$pipCode=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($pipCode -ne 0){throw 'Broker tools installation failed; inspect local install log.'}
 $r.tools=(& $python -c "import sys,json;sys.path.insert(0,r'C:\CornGrid\agent\broker-python');import MetaTrader5,numpy;print(json.dumps(dict(mt5=MetaTrader5.__version__,numpy=numpy.__version__)))")|ConvertFrom-Json
 if($LASTEXITCODE -ne 0){throw 'Broker tools failed to load.'}
 $r.phase='preparing-clean-mt5';Save
 $source='C:\Program Files\JustMarkets MetaTrader 5';$base='C:\CornGrid\Sandbox\MT5'
 if(@(Get-Process terminal64 -ErrorAction SilentlyContinue|Where-Object {$_.Path -like ($source+'\*')}).Count){throw 'The source terminal is running.'}
 foreach($item in Get-ChildItem -LiteralPath $source){
  if($item.Name.ToLowerInvariant() -in @('config','profiles','logs','bases','tester','reports','history','metaeditor64.exe','metatester64.exe','uninstall.exe','origin.txt')){continue}
  Copy-Item -LiteralPath $item.FullName -Destination $base -Recurse -Force
 }
 $profile='C:\Users\Administrator\AppData\Roaming\MetaQuotes\Terminal\5FFA568149E88FCD5B44D926DCFEAA79\config\common.ini'
 $text=[IO.File]::ReadAllText($profile,[Text.Encoding]::Unicode);$section=[regex]::Match($text,'(?s)\[Experts\](.*?)(?=\r?\n\[|$)').Groups[1].Value
 $urls=@($section -split '\r?\n'|Where-Object {$_ -match '^WebRequest(?:Url)?='})
 if(-not @($urls|Where-Object {$_ -match '^WebRequestUrl=.+'}).Count){throw 'Protected WebRequest settings must be configured.'}
 New-Item -ItemType Directory -Path 'C:\CornGrid\Sandbox\WebRequest' -Force|Out-Null
 [IO.File]::WriteAllText('C:\CornGrid\Sandbox\WebRequest\common.ini',('[Experts]'+"`r`n"+($urls -join "`r`n")+"`r`n"),[Text.Encoding]::Unicode)
 $r.freeDiskMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB);$r.phase='runtime-ready';Save
}catch{$r.phase='failed';$r.error=$_.Exception.Message;Save}
