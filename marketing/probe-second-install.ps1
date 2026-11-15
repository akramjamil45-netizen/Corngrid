$r=@{at=[DateTime]::UtcNow.ToString('o');host=$env:COMPUTERNAME}
foreach($pair in @(@('nodeZip','C:\CornGrid\InstallTemp\node.zip'),@('nodeExe','C:\Program Files\nodejs\node.exe'),@('pythonExe','C:\Program Files\Python313\python.exe'))){$item=Get-Item -LiteralPath $pair[1] -ErrorAction SilentlyContinue;$r[$pair[0]]=if($item){$item.Length}else{$null}}
$r.diskFreeMb=[math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace/1MB)
[IO.File]::WriteAllText('\\tsclient\C\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\marketing\second-vps-install-probe.json',($r|ConvertTo-Json -Compress))
