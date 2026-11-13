param([string]$Installer,[string]$Case)
$ErrorActionPreference='Stop'
$global:NodeInstallCase=$Case
$global:NodeInstallRegistered=$null
$global:NodeInstallStarts=0
function global:Get-ScheduledTask { param($TaskName,$ErrorAction)
    if($global:NodeInstallCase -eq 'Existing'){return [pscustomobject]@{State='Ready'}}
    if($global:NodeInstallCase -eq 'Running'){return [pscustomobject]@{State='Running'}}
}
function global:New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory)
    return [pscustomobject]@{Execute=$Execute;Argument=$Argument;WorkingDirectory=$WorkingDirectory}
}
function global:New-ScheduledTaskTrigger { param([switch]$AtLogOn,[switch]$AtStartup,$User,[switch]$Once,$At,$RepetitionInterval)
    return [pscustomobject]@{AtLogOn=[bool]$AtLogOn;AtStartup=[bool]$AtStartup;User=$User;Once=[bool]$Once;At=$At;Repetition=[pscustomobject]@{IntervalMinutes=if($RepetitionInterval){$RepetitionInterval.TotalMinutes}else{0};Duration=$null;StopAtDurationEnd=$true}}
}
function global:New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel)
    return [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel}
}
function global:New-ScheduledTaskSettingsSet { param($RestartCount,$RestartInterval,$ExecutionTimeLimit,$MultipleInstances,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries)
    return [pscustomobject]@{MultipleInstances=$MultipleInstances;ExecutionSeconds=$ExecutionTimeLimit.TotalSeconds;RestartCount=$RestartCount}
}
function global:Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force)
    $global:NodeInstallRegistered=@{name=$TaskName;action=$Action;trigger=$Trigger;principal=$Principal;settings=$Settings;force=[bool]$Force}
}
function global:Start-ScheduledTask { param($TaskName,$ErrorAction) $global:NodeInstallStarts++ }
# Every mutating Task Scheduler command must resolve to the in-process mock.
foreach($name in @('Register-ScheduledTask','Start-ScheduledTask')){
    if((Get-Command $name).CommandType -ne 'Function'){throw 'Unsafe test harness: a real task command would run.'}
}
$failure=$null
try{
    switch($Case){
        'System' { & $Installer -Mode System -NoStart }
        'WhatIf' { & $Installer -WhatIf }
        'Running' { & $Installer -Replace -NoStart }
        default { & $Installer -NoStart }
    }
}catch{$failure=$_.Exception.Message}
Write-Output ('CORNGRID_TEST_RESULT '+(@{registration=$global:NodeInstallRegistered;starts=$global:NodeInstallStarts;error=$failure} | ConvertTo-Json -Depth 7 -Compress))
