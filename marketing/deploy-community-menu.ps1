$ErrorActionPreference='Stop'
$report=Join-Path $PSScriptRoot 'community-menu-deployment-result.json'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $child=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 if($child.ExitCode -ne 0){throw 'Community menu deployment failed.'}
 Get-Content -LiteralPath $report
 exit
}
if($env:COMPUTERNAME -ne 'WINSLET'){throw 'Wrong deployment host.'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'Corngrid-web\public\dashboard.html'
$target='C:\Website\Website\Corngrid-web\public\dashboard.html'
$backup=Join-Path 'C:\ProgramData\CornGrid\WebsiteBackups' ('community-menu-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
$result=[ordered]@{phase='starting';backup=$backup;serverRestarted=$false;adminMenuChanged=$false}
$changed=$false
try{
 $pattern='<nav class="main-nav"[^>]*>[\s\S]*?</nav>'
 $desired=[regex]::Match([IO.File]::ReadAllText($source),$pattern)
 $html=[IO.File]::ReadAllText($target)
 $current=[regex]::Match($html,$pattern)
 if(-not $desired.Success -or -not $current.Success){throw 'Navigation missing.'}
 $itemPattern='<(button|a)\b[\s\S]*?</\1>'
 $before=@([regex]::Matches($current.Value,$itemPattern)|ForEach-Object{$_.Value}|Sort-Object)
 $after=@([regex]::Matches($desired.Value,$itemPattern)|ForEach-Object{$_.Value}|Sort-Object)
 if($before.Count -ne $after.Count -or @(Compare-Object $before $after -CaseSensitive).Count){throw 'Menu permissions or items changed; refusing deployment.'}
 $order=@([regex]::Matches($desired.Value,'data-page="([^"]+)"')|ForEach-Object{$_.Groups[1].Value})
 if($order[0] -ne 'feed' -or $order[1] -ne 'chat'){throw 'Community must be first.'}
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'dashboard.html')
 $updated=$html.Remove($current.Index,$current.Length).Insert($current.Index,$desired.Value)
 $changed=$true
 [IO.File]::WriteAllText($target,$updated,(New-Object Text.UTF8Encoding($false)))
 $verification=& node.exe (Join-Path $PSScriptRoot 'verify-menu-priority.cjs')
 if($LASTEXITCODE -ne 0){throw 'Live menu verification failed.'}
 $result.verification=($verification -join '')|ConvertFrom-Json
 $result.phase='complete'
}catch{
 if($changed){Copy-Item -LiteralPath (Join-Path $backup 'dashboard.html') -Destination $target -Force}
 $result.phase='failed';$result.error=$_.Exception.Message
 [IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 5 -Compress))
 throw
}
$result.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 5 -Compress))
