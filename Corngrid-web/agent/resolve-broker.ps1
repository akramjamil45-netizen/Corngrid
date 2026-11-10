param(
 [Parameter(Mandatory=$true)][string]$InstanceDir,
 [Parameter(Mandatory=$true)][string]$Search,
 [Parameter(Mandatory=$true)][string]$PythonPath,
 [Parameter(Mandatory=$true)][string]$RequestId
)
$ErrorActionPreference='Stop'
$InstanceDir=[IO.Path]::GetFullPath($InstanceDir)
if((Split-Path $InstanceDir -Leaf) -notmatch '^(sbx|eatest)_[a-f0-9]{18}$'){throw 'Invalid sandbox path'}
$terminal=Join-Path $InstanceDir 'terminal64.exe'
$result=Join-Path $InstanceDir 'config\broker-preflight-result.json'
$phase='starting the isolated terminal'
$owned=$false
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class CornGridBrokerWindows {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc fn,IntPtr p);
 [DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr h,EnumProc fn,IntPtr p);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]public static extern IntPtr GetMenu(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetSubMenu(IntPtr h,int n);
 [DllImport("user32.dll")]public static extern int GetMenuItemCount(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetMenuString(IntPtr h,uint n,StringBuilder s,int c,uint f);
 [DllImport("user32.dll")]public static extern uint GetMenuItemID(IntPtr h,int n);
 [DllImport("user32.dll")]public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l);
 public static IntPtr Window(int pid,string kind){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)return true;var name=new StringBuilder(256);if(kind=="terminal"){GetClassName(h,name,256);if(!name.ToString().Contains("MetaTrader"))return true;}else{GetWindowText(h,name,256);if(name.ToString()!=kind)return true;}found=h;return false;},IntPtr.Zero);return found;}
 public static IntPtr Control(IntPtr parent,int id){IntPtr found=IntPtr.Zero;EnumChildWindows(parent,(h,p)=>{if(GetDlgCtrlID(h)!=id)return true;found=h;return false;},IntPtr.Zero);return found;}
 public static uint Command(IntPtr menu,string label){for(int i=0;i<GetMenuItemCount(menu);i++){var text=new StringBuilder(256);GetMenuString(menu,(uint)i,text,256,1024);if(text.ToString().Replace("&","")==label)return GetMenuItemID(menu,i);}return 0;}
 public static IntPtr FileMenu(IntPtr window){var menu=GetMenu(window);for(int i=0;i<GetMenuItemCount(menu);i++){var text=new StringBuilder(256);GetMenuString(menu,(uint)i,text,256,1024);if(text.ToString().Replace("&","")=="File")return GetSubMenu(menu,i);}return IntPtr.Zero;}
}
'@
try {
 $existing=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminal })
 if($existing.Count){throw 'Preflight requires an idle sandbox terminal directory'}
 $startup=Join-Path $InstanceDir 'config\broker-preflight.ini'
 $process=Start-Process -FilePath $terminal -ArgumentList @('/portable',('/config:"'+$startup+'"')) -WorkingDirectory $InstanceDir -WindowStyle Hidden -PassThru
 $owned=$true
 $deadline=(Get-Date).AddSeconds(30)
 do {
  $window=[CornGridBrokerWindows]::Window($process.Id,'terminal')
  if($window -ne [IntPtr]::Zero){break}
  Start-Sleep -Milliseconds 250
 }while((Get-Date) -lt $deadline)
 if($window -eq [IntPtr]::Zero){throw 'MT5 main window unavailable'}
 $phase='searching the MT5 broker directory'
 $menu=[CornGridBrokerWindows]::FileMenu($window)
 $command=[CornGridBrokerWindows]::Command($menu,'Open an Account')
 if(-not $command){throw 'MT5 broker directory menu unavailable; use an English MT5 terminal'}
 [void][CornGridBrokerWindows]::PostMessage($window,273,[IntPtr]$command,[IntPtr]::Zero)
 $deadline=(Get-Date).AddSeconds(10)
 do {
  $dialog=[CornGridBrokerWindows]::Window($process.Id,'Open an Account')
  if($dialog -ne [IntPtr]::Zero){break}
  Start-Sleep -Milliseconds 250
 }while((Get-Date) -lt $deadline)
 if($dialog -eq [IntPtr]::Zero){throw 'MT5 broker directory did not open'}
 $edit=[CornGridBrokerWindows]::Control($dialog,10814)
 $find=[CornGridBrokerWindows]::Control($dialog,10815)
 if($edit -eq [IntPtr]::Zero -or $find -eq [IntPtr]::Zero){throw 'MT5 broker search controls unavailable'}
 [void][CornGridBrokerWindows]::SendMessage($edit,12,[IntPtr]::Zero,$Search)
 [void][CornGridBrokerWindows]::SendMessage($find,245,[IntPtr]::Zero,$null)
 Start-Sleep -Seconds 12
 $cancel=[CornGridBrokerWindows]::Control($dialog,2)
 if($cancel -eq [IntPtr]::Zero){throw 'Cannot close MT5 broker search safely'}
 [void][CornGridBrokerWindows]::SendMessage($cancel,245,[IntPtr]::Zero,$null)
 $phase='verifying broker login and reading account symbols'
 & $PythonPath (Join-Path $PSScriptRoot 'broker-probe.py') $InstanceDir $RequestId | Out-Null
 if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $result)){throw 'Python MT5 verification failed'}
}catch{
 # Do not log raw exceptions: local configuration and process arguments can contain credentials.
 $message='MT5 preflight failed while '+$phase+'. Check the English MT5 terminal, Python tools and broker connectivity.'
 @{ok=$false;requestId=$RequestId;error=$message} | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
}finally{
 if($owned){
  $targets=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -eq $terminal })
  foreach($target in $targets){
   $item=Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
   if($item){[void]$item.CloseMainWindow();if(-not $item.WaitForExit(5000)){Stop-Process -Id $item.Id -Force}}
  }
 }
}
