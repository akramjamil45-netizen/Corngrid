param([switch]$Capture,[switch]$OpenLogin,[switch]$SubmitLogin,[switch]$Diagnostic)
$ErrorActionPreference='Stop'
trap { $_ | Out-String | Set-Content (Join-Path $PSScriptRoot 'mt5-desktop-error.txt'); exit 1 }
if ($Capture) {
 if ($Diagnostic) {
  & 'C:\Users\mohamad akram\AppData\Local\Programs\Python\Python313\python.exe' (Join-Path $PSScriptRoot 'diagnose-broker.py') 2>&1 | Set-Content (Join-Path $PSScriptRoot 'broker-python-run.txt')
  exit
 }
 Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes
 if ($SubmitLogin) {
  $loginWindow=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'Login')))
  if (-not $loginWindow) { throw 'MT5 login dialog is not open.' }
  $okButton=$loginWindow.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'OK')))
  $okButton.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Seconds 3
 }
 if ($OpenLogin) {
  Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Mt5Menus {
 [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr w);
 [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m,int p);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m,uint p,StringBuilder s,int c,uint f);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr m,int p);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr w,uint m,IntPtr p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
}
'@
  $desktopShell=New-Object -ComObject WScript.Shell
  $desktopWindow=(Get-Process terminal64 | Select-Object -First 1).MainWindowHandle
  $desktopShell.AppActivate((Get-Process terminal64 | Select-Object -First 1).Id) | Out-Null
  $desktopShell.SendKeys('{ESC}')
  $desktopShell.SendKeys('%f')
  Start-Sleep -Milliseconds 400
  [void][Mt5Menus]::SetCursorPos(109,414)
  [Mt5Menus]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [Mt5Menus]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  $fileMenu=[Mt5Menus]::GetSubMenu([Mt5Menus]::GetMenu($desktopWindow),0)
  for ($menuIndex=0;$menuIndex -lt [Mt5Menus]::GetMenuItemCount($fileMenu);$menuIndex++) {
   $menuLabel=New-Object Text.StringBuilder 256
   [void][Mt5Menus]::GetMenuString($fileMenu,$menuIndex,$menuLabel,256,1024)
   if ($menuLabel.ToString().Replace('&','') -like '*Login to Trade Account*') {
    [void][Mt5Menus]::PostMessage($desktopWindow,273,[IntPtr][Mt5Menus]::GetMenuItemID($fileMenu,$menuIndex),[IntPtr]::Zero)
   }
  }
  Start-Sleep -Seconds 1
 }
 $screenBounds=[Windows.Forms.SystemInformation]::VirtualScreen
 $screenImage=New-Object Drawing.Bitmap($screenBounds.Width,$screenBounds.Height)
 $screenGraphics=[Drawing.Graphics]::FromImage($screenImage)
 $screenGraphics.CopyFromScreen($screenBounds.Location,[Drawing.Point]::Empty,$screenBounds.Size)
 $screenImage.Save((Join-Path $PSScriptRoot 'mt5-desktop.png'))
 $screenGraphics.Dispose(); $screenImage.Dispose()
 $window=Get-Process terminal64 | Select-Object -First 1
 $element=[Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
 $elements=$element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
 @($elements | ForEach-Object { if ($_.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { $_.Current.Name } }) | Set-Content (Join-Path $PSScriptRoot 'mt5-desktop.txt')
 exit
}
$desktopPrincipal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $desktopPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"' + $(if ($OpenLogin) {' -OpenLogin'}) + $(if ($SubmitLogin) {' -SubmitLogin'}) + $(if ($Diagnostic) {' -Diagnostic'})) -Verb RunAs -WindowStyle Hidden -Wait
 exit
}
$desktopAgentTask=Get-ScheduledTask CornGridSandboxAgent
Get-ScheduledTask -TaskName CornGridInspectDesktop -ErrorAction SilentlyContinue | Stop-ScheduledTask
$desktopAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$PSCommandPath+'" -Capture' + $(if ($OpenLogin) {' -OpenLogin'}) + $(if ($SubmitLogin) {' -SubmitLogin'}) + $(if ($Diagnostic) {' -Diagnostic'}))
$desktopTaskPrincipal=New-ScheduledTaskPrincipal -UserId $desktopAgentTask.Principal.UserId -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName CornGridInspectDesktop -Action $desktopAction -Principal $desktopTaskPrincipal -Force | Out-Null
Start-ScheduledTask CornGridInspectDesktop
