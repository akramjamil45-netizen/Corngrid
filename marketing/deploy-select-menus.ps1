$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'select-menus-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'CornGrid menu deployment failed; inspect the deployment report.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public'
$target='C:\Website\Website'
$assets=@('corngrid-select.css','corngrid-select.js')
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('select-menus-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='starting';backup=$backup;changed=@();serverRestarted=$false;databaseModified=$false}
$planned=@{};$existed=@{}
try{
 foreach($name in $assets){
  $file=Join-Path $target ('Corngrid-web\public\'+$name)
  if((Test-Path -LiteralPath $file) -and (Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $name)).Hash){throw ('Unreviewed production component: '+$name)}
 }
 foreach($name in @('dashboard.html','admin.html')){
  $relative='Corngrid-web\public\'+$name;$html=[IO.File]::ReadAllText((Join-Path $target $relative))
  if(-not $html.Contains('corngrid-select.js')){
   if(([regex]::Matches($html,'</head>')).Count -ne 1){throw 'Unexpected HTML head marker.'}
   $tags='  <link rel="stylesheet" href="corngrid-select.css?v=20261115-menus1">'+[Environment]::NewLine+'  <script src="corngrid-select.js?v=20261115-menus1" defer></script>'+[Environment]::NewLine
   $planned[$relative]=$html.Replace('</head>',$tags+'</head>')
  }elseif(-not $html.Contains('corngrid-select.js?v=20261115-menus1') -or -not $html.Contains('corngrid-select.css?v=20261115-menus1')){throw 'Unreviewed component registration.'}
 }
 $web=[IO.File]::ReadAllText((Join-Path $target 'web.config'))
 if(-not $web.Contains('|corngrid-select\.(?:css|js)|')){
  $marker='|table-cards\.js|'
  if(([regex]::Matches($web,[regex]::Escape($marker))).Count -ne 1){throw 'Unexpected IIS asset rule.'}
  $web=$web.Replace($marker,'|corngrid-select\.(?:css|js)|table-cards\.js|')
  $null=[xml]$web
  $planned['web.config']=$web
 }
 $sw=[IO.File]::ReadAllText((Join-Path $target 'sw.js'))
 if(-not $sw.Contains("'/corngrid-select.js'")){
  $marker="  '/dashboard.js',"
  if(([regex]::Matches($sw,[regex]::Escape($marker))).Count -ne 2){throw 'Unexpected worker asset markers.'}
  $addition=$marker+[Environment]::NewLine+"  '/corngrid-select.css',"+[Environment]::NewLine+"  '/corngrid-select.js',"
  $planned['sw.js']=$sw.Replace($marker,$addition)
 }
 $files=@($assets|ForEach-Object{'Corngrid-web\public\'+$_})+@($planned.Keys)
 $before=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 foreach($relative in $files){
  $file=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $file.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe deployment path.'}
  $existed[$relative]=Test-Path -LiteralPath $file
  if($existed[$relative]){$saved=Join-Path $backup $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force|Out-Null;Copy-Item -LiteralPath $file -Destination $saved}
 }
 foreach($name in $assets){
  $relative='Corngrid-web\public\'+$name;$result.changed+=$relative
  Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $relative) -Force
 }
 foreach($relative in $planned.Keys){
  $result.changed+=$relative
  [IO.File]::WriteAllText((Join-Path $target $relative),$planned[$relative],(New-Object Text.UTF8Encoding($false)))
 }
 $verification=& node.exe (Join-Path $PSScriptRoot 'verify-select-menu-assets.cjs')
 if($LASTEXITCODE -ne 0){throw 'Live component verification failed.'}
 $result.verification=($verification -join '')|ConvertFrom-Json
 $after=@(Get-Process terminal64 -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
 if(@($before|Where-Object{$_ -notin $after}).Count){throw 'A pre-existing MT5 process is missing.'}
 $result.terminalPidsPreserved=$before;$result.phase='complete'
}catch{
 $result.phase='failed';$result.error=$_.Exception.Message;$result.rollbackErrors=@()
 foreach($relative in $result.changed){try{
  $file=[IO.Path]::GetFullPath((Join-Path $target $relative))
  if(-not $file.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe rollback path.'}
  if($existed[$relative]){Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination $file -Force}else{Remove-Item -LiteralPath $file -Force}
 }catch{$result.rollbackErrors+=$relative}}
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 6 -Compress))
 throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 6 -Compress))
