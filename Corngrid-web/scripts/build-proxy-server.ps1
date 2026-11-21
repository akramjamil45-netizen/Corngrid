[CmdletBinding()]
param([string]$OutputPath='')
$ErrorActionPreference='Stop'
$backend=Split-Path -Parent $PSScriptRoot;$workspace=Split-Path -Parent $backend
if(-not $OutputPath){$OutputPath=Join-Path $workspace 'CornGrid-Proxy-Server.zip'}
$files=@(@('proxy\windows\Install-CornGridProxy.ps1','Install-CornGridProxy.ps1'),@('proxy\windows\Uninstall-CornGridProxy.ps1','Uninstall-CornGridProxy.ps1'),@('proxy\windows\Test-CornGridProxy.ps1','Test-CornGridProxy.ps1'),@('proxy\server.js','proxy/server.js'),@('proxy\control-client.js','proxy/control-client.js'),@('agent\proxy-protocol.js','agent/proxy-protocol.js'),@('docs\PROXY_SERVER_WINDOWS.md','PROXY_SERVER_WINDOWS.md'))
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$destination=[IO.Path]::GetFullPath($OutputPath)
if(-not(Test-Path -LiteralPath (Split-Path -Parent $destination))){throw 'Output directory does not exist.'}
$temporary=$destination+'.tmp-'+[guid]::NewGuid().ToString()+'.zip'
try{
 $zip=[IO.Compression.ZipFile]::Open($temporary,[IO.Compression.ZipArchiveMode]::Create)
 try{$manifest=@();foreach($file in $files){$from=Join-Path $backend $file[0];[void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$from,$file[1]);$manifest+=@{path=$file[1];sha256=(Get-FileHash -LiteralPath $from).Hash.ToLowerInvariant()}}
  $entry=$zip.CreateEntry('MANIFEST.json');$writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false));try{$writer.Write((@{format=1;version='1.0.0';files=$manifest}|ConvertTo-Json -Depth 5))}finally{$writer.Dispose()}
 }finally{$zip.Dispose()}
 Move-Item -LiteralPath $temporary -Destination $destination -Force
 Write-Host ('Built proxy installation package: '+$destination)
 (Get-FileHash -LiteralPath $destination)|Select-Object Hash
}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
