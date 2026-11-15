param([switch]$Submit,[switch]$ScanBroker,[switch]$Status,[switch]$RepairSymbol,[switch]$RepairState)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"'+$(if($Submit){' -Submit'})+$(if($ScanBroker){' -ScanBroker'})+$(if($Status){' -Status'})+$(if($RepairSymbol){' -RepairSymbol'})+$(if($RepairState){' -RepairState'})
 $child=Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
 Get-Content (Join-Path $PSScriptRoot 'mt5-desktop-danny-login.log') -ErrorAction SilentlyContinue
 if($child.ExitCode -ne 0){throw 'Elevated login inspection failed'}
 exit
}
Start-Transcript -Path (Join-Path $PSScriptRoot 'mt5-desktop-danny-login.log') -Force | Out-Null
if($RepairState){
 & node (Join-Path $PSScriptRoot 'repair-danny-state.cjs') --repair
 if($LASTEXITCODE -ne 0){throw 'Danny state repair failed'}
 $terminal=Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq 'C:\CornGrid\Sandbox\Users\sbx_4ee7c0937ec602a4a8\terminal64.exe' }
 foreach($item in $terminal){Stop-Process -Id $item.ProcessId -Force}
 Write-Output 'Danny terminal will recover with canonical server and dashboard credentials.'
 exit
}
if($RepairSymbol){
 $targetRoot='C:\CornGrid\Sandbox\Users\sbx_4ee7c0937ec602a4a8'
 $backup=Join-Path $targetRoot ('symbol-repair-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $backup | Out-Null
 foreach($file in @('sandbox-startup.ini','common.ini')){
  $source=Join-Path $targetRoot ('config\'+$file)
  if(Test-Path -LiteralPath $source){
   Copy-Item -LiteralPath $source -Destination (Join-Path $backup $file)
   $text=[IO.File]::ReadAllText($source)
   $text=$text -replace '(?m)^Symbol=XAUUSD\r?$', 'Symbol=XAUUSD.c'
   [IO.File]::WriteAllText($source,$text,[Text.Encoding]::Unicode)
  }
 }
 $cfgPath='C:\Website\Website\Corngrid-web\agent\agent-config.json'
 Copy-Item -LiteralPath $cfgPath -Destination (Join-Path $backup 'agent-config.json')
 $cfg=Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
 if(-not $cfg.brokerSymbolMaps){$cfg | Add-Member NoteProperty brokerSymbolMaps ([pscustomobject]@{}) -Force}
 foreach($server in @('JustMarkets-DEMO6','JustMarkets-Demo6')){
  $cfg.brokerSymbolMaps | Add-Member NoteProperty $server ([pscustomobject]@{XAUUSD='XAUUSD.c'}) -Force
 }
 if(-not $cfg.brokerServerDataDirs){$cfg | Add-Member NoteProperty brokerServerDataDirs ([pscustomobject]@{}) -Force}
 foreach($server in @('JustMarkets-DEMO6','JustMarkets-Demo6')){$cfg.brokerServerDataDirs | Add-Member NoteProperty $server $targetRoot -Force}
 $json=$cfg | ConvertTo-Json -Depth 12
 [IO.File]::WriteAllText($cfgPath,$json,(New-Object Text.UTF8Encoding $false))
 $terminal=Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $targetRoot 'terminal64.exe') }
 foreach($item in $terminal){Stop-Process -Id $item.ProcessId -Force}
 Write-Output ('Updated Danny symbol to XAUUSD.c; broker directory preserved; backup='+$backup)
 exit
}
if($Status){
 & 'C:\Users\mohamad akram\AppData\Local\Programs\Python\Python313\python.exe' (Join-Path $PSScriptRoot 'diagnose-danny.py') --status
 exit
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class DannyLoginMenu {
[DllImport("user32.dll")]public static extern IntPtr GetMenu(IntPtr h);
[DllImport("user32.dll")]public static extern IntPtr GetSubMenu(IntPtr h,int n);
[DllImport("user32.dll")]public static extern int GetMenuItemCount(IntPtr h);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetMenuString(IntPtr h,uint n,StringBuilder s,int c,uint f);
[DllImport("user32.dll")]public static extern uint GetMenuItemID(IntPtr h,int n);
[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr h,EnumProc callback,IntPtr l);
public delegate bool EnumProc(IntPtr h,IntPtr l);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int c);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int c);
[DllImport("user32.dll")]public static extern int GetDlgCtrlID(IntPtr h);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l);
public static IntPtr FindControl(IntPtr parent,int control){IntPtr found=IntPtr.Zero;EnumChildWindows(parent,(h,l)=>{if(GetDlgCtrlID(h)==control){found=h;return false;}return true;},IntPtr.Zero);return found;}
public struct Rect{public int L,T,R,B;}
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc callback,IntPtr l);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
public static IntPtr FindTerminal(int pid){IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid){var c=new StringBuilder(256);GetClassName(h,c,256);if(c.ToString().Contains("MetaTrader")){found=h;return false;}}return true;},IntPtr.Zero);return found;}
public static IntPtr FindLogin(int pid){IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{uint id;GetWindowThreadProcessId(h,out id);var title=new StringBuilder(256);GetWindowText(h,title,256);if(id==pid&&(title.ToString()=="Login"||title.ToString().Contains("Open an Account"))){found=h;return false;}return true;},IntPtr.Zero);return found;}
}
'@
$root='C:\CornGrid\Sandbox\Users\sbx_4ee7c0937ec602a4a8'
$proc=Get-Process terminal64 | Where-Object { $_.Path -eq (Join-Path $root 'terminal64.exe') } | Select-Object -First 1
if(-not $proc){throw 'Danny terminal is not running'}
$terminalWindow=[DannyLoginMenu]::FindTerminal($proc.Id)
Write-Output ('Terminal PID='+$proc.Id+' HWND='+$terminalWindow)
if($terminalWindow -eq [IntPtr]::Zero){throw 'Terminal has no MT5 main window'}
$mainMenu=[DannyLoginMenu]::GetMenu($terminalWindow)
$menu=[IntPtr]::Zero
for($top=0;$top -lt [DannyLoginMenu]::GetMenuItemCount($mainMenu);$top++){
 $name=New-Object Text.StringBuilder 256
 [void][DannyLoginMenu]::GetMenuString($mainMenu,$top,$name,256,1024)
 if($name.ToString().Replace('&','') -eq 'File'){$menu=[DannyLoginMenu]::GetSubMenu($mainMenu,$top);break}
}
if($menu -eq [IntPtr]::Zero){throw 'MT5 File menu not found'}
for($i=0;$i -lt [DannyLoginMenu]::GetMenuItemCount($menu);$i++){
 $label=New-Object Text.StringBuilder 256
 [void][DannyLoginMenu]::GetMenuString($menu,$i,$label,256,1024)
 Write-Output ('File menu: '+$label.ToString())
 if($label.ToString().Replace('&','') -like '*Login to Trade Account*'){$loginCommand=[DannyLoginMenu]::GetMenuItemID($menu,$i)}
 if(((-not $ScanBroker) -and $label.ToString().Replace('&','') -like '*Login to Trade Account*') -or ($ScanBroker -and $label.ToString().Replace('&','') -eq 'Open an Account')){
  [void][DannyLoginMenu]::PostMessage($terminalWindow,273,[IntPtr][DannyLoginMenu]::GetMenuItemID($menu,$i),[IntPtr]::Zero)
 }
}
Start-Sleep -Seconds 1
[void][DannyLoginMenu]::ShowWindow($terminalWindow,9)
[void][DannyLoginMenu]::SetForegroundWindow($terminalWindow)
Start-Sleep -Seconds 1
$loginHandle=[DannyLoginMenu]::FindLogin($proc.Id)
Write-Output ('Login HWND='+$loginHandle)
if($loginHandle -ne [IntPtr]::Zero){
 [void][DannyLoginMenu]::ShowWindow($loginHandle,9)
 [void][DannyLoginMenu]::SetForegroundWindow($loginHandle)
 $captureWindow=$loginHandle
}else{$captureWindow=$terminalWindow}
if($ScanBroker){
 $search=[DannyLoginMenu]::FindControl($loginHandle,10814)
 $find=[DannyLoginMenu]::FindControl($loginHandle,10815)
 if($search -eq [IntPtr]::Zero -or $find -eq [IntPtr]::Zero){throw 'Broker search controls unavailable'}
 [void][DannyLoginMenu]::SendMessage($search,12,[IntPtr]::Zero,'JustMarkets')
 [void][DannyLoginMenu]::SendMessage($find,245,[IntPtr]::Zero,$null)
 Start-Sleep -Seconds 12
 Write-Output 'JustMarkets broker directory search completed.'
 if($Submit){
  $cancel=[DannyLoginMenu]::FindControl($loginHandle,2)
  [void][DannyLoginMenu]::SendMessage($cancel,245,[IntPtr]::Zero,$null)
  [void][DannyLoginMenu]::PostMessage($terminalWindow,273,[IntPtr]$loginCommand,[IntPtr]::Zero)
  Start-Sleep -Seconds 1
  $loginHandle=[DannyLoginMenu]::FindLogin($proc.Id)
  if($loginHandle -eq [IntPtr]::Zero){throw 'Login dialog unavailable after broker scan'}
  [void][DannyLoginMenu]::ShowWindow($loginHandle,9)
  $captureWindow=$loginHandle
 }
}
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds=New-Object DannyLoginMenu+Rect
[void][DannyLoginMenu]::GetWindowRect($captureWindow,[ref]$bounds)
$bmp=New-Object Drawing.Bitmap(($bounds.R-$bounds.L),($bounds.B-$bounds.T))
$graphics=[Drawing.Graphics]::FromImage($bmp)
$dc=$graphics.GetHdc()
[void][DannyLoginMenu]::PrintWindow($captureWindow,$dc,2)
$graphics.ReleaseHdc($dc)
$bmp.Save((Join-Path $PSScriptRoot 'mt5-desktop-danny-visible.png'))
$graphics.Dispose();$bmp.Dispose()
$window=[Windows.Automation.AutomationElement]::FromHandle($terminalWindow)
$callback=[DannyLoginMenu+EnumProc]{param($handle,$unused)
 $class=New-Object Text.StringBuilder 128
 [void][DannyLoginMenu]::GetClassName($handle,$class,128)
 if($class.ToString() -match 'Edit|Combo|Button|Static|#32770'){
  Write-Host ('Native '+$class+' id='+[DannyLoginMenu]::GetDlgCtrlID($handle)+' handle='+$handle)
 }
 return $true
}
[void][DannyLoginMenu]::EnumChildWindows($captureWindow,$callback,[IntPtr]::Zero)
$children=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
foreach($e in $children){
 if($e.Current.ControlType.ProgrammaticName -in @('ControlType.Window','ControlType.Text','ControlType.Button','ControlType.ComboBox','ControlType.Edit')){
  Write-Output ($e.Current.ControlType.ProgrammaticName+': '+$e.Current.Name+' id='+$e.Current.AutomationId)
 }
}
if($Submit){
 $dialog=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Login')))
 if(-not $dialog){throw 'Login dialog not found'}
 [void][DannyLoginMenu]::PostMessage([IntPtr]$dialog.Current.NativeWindowHandle,273,[IntPtr]1,[IntPtr]::Zero)
 Write-Output 'Stored login submitted.'
 Start-Sleep -Seconds 8
 Get-Content -LiteralPath (Join-Path $root 'logs\20261106.log') -Tail 18
 & 'C:\Users\mohamad akram\AppData\Local\Programs\Python\Python313\python.exe' (Join-Path $PSScriptRoot 'diagnose-danny.py')
}
