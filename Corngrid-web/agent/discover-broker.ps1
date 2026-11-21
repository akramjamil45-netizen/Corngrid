param(
 [Parameter(Mandatory=$true)][string]$TerminalDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9 .&()_/-]{1,80}$')][string]$Search,
 [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9 ._/-]{1,128}$')][string]$ExpectedServer,
 [Parameter(Mandatory=$true)][string]$StartupFile,
 [ValidateRange(10,120)][int]$TimeoutSeconds=60
)
$ErrorActionPreference='Stop'
$directory=[IO.Path]::GetFullPath($TerminalDirectory);$terminal=Join-Path $directory 'terminal64.exe';$servers=Join-Path $directory 'config\servers.dat'
# Operate only on the exact dedicated preflight executable. Credentials stay
# in local files and are used only for an existing account; never create an
# account, attach an EA or send trading commands.
$owners=@(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'"|Where-Object{$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $terminal})
if($owners.Count -ne 1){throw 'Broker discovery requires one owned preflight terminal.'}
$ownedPid=[int]$owners[0].ProcessId
$phase='opening the broker directory';$observedNames=@()
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
using System.Collections.Generic;
public class CornGridBrokerDiscovery {
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
 [DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]static extern IntPtr SendText(IntPtr h,uint m,IntPtr w,string l,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")]static extern IntPtr ReadText(IntPtr h,uint m,IntPtr w,StringBuilder l,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")]static extern IntPtr SendPtr(IntPtr h,uint m,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
 public static IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l){IntPtr r;if(h==IntPtr.Zero||SendText(h,m,w,l,2,5000,out r)==IntPtr.Zero)throw new Exception("Broker control did not answer");return r;}
 public static IntPtr Ptr(IntPtr h,uint m,IntPtr w,IntPtr l){IntPtr r;if(h==IntPtr.Zero||SendPtr(h,m,w,l,2,5000,out r)==IntPtr.Zero)throw new Exception("Broker control did not answer");return r;}
 public static IntPtr[] Controls(IntPtr parent,string cls){var rows=new List<IntPtr>();EnumChildWindows(parent,(h,p)=>{var s=new StringBuilder(256);GetClassName(h,s,256);if(!IsWindowVisible(h)||s.ToString()!=cls)return true;if(cls=="Edit"){s.Clear();GetClassName(GetParent(h),s,256);if(s.ToString()=="ComboBox")return true;}rows.Add(h);return true;},IntPtr.Zero);return rows.ToArray();}
 public static string[] Labels(IntPtr dialog){var rows=new List<string>();foreach(var cls in new[]{"Button","Static"})foreach(var h in Controls(dialog,cls)){var s=new StringBuilder(256);GetWindowText(h,s,256);rows.Add(cls+":"+GetDlgCtrlID(h)+":"+s.ToString());}return rows.ToArray();}
 public static string[] Items(IntPtr combo){var rows=new List<string>();int count=Ptr(combo,326,IntPtr.Zero,IntPtr.Zero).ToInt32();if(count<0||count>100)throw new Exception("Invalid broker server list");for(int i=0;i<count;i++){int length=Ptr(combo,329,(IntPtr)i,IntPtr.Zero).ToInt32();if(length<1||length>128)throw new Exception("Invalid broker server name");var s=new StringBuilder(length+1);IntPtr r;if(ReadText(combo,328,(IntPtr)i,s,2,5000,out r)==IntPtr.Zero)throw new Exception("Broker server list did not answer");rows.Add(s.ToString());}return rows.ToArray();}
 public static IntPtr Window(int pid,string title){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid||(title!="terminal"&&!IsWindowVisible(h)))return true;var name=new StringBuilder(256);if(title=="terminal"){GetClassName(h,name,256);if(!name.ToString().Contains("MetaTrader"))return true;}else{GetWindowText(h,name,256);if(title=="broker-account"){if(!name.ToString().StartsWith("Open an Account:"))return true;}else if(name.ToString()!=title)return true;}found=h;return false;},IntPtr.Zero);return found;}
 public static IntPtr Control(IntPtr parent,int id){IntPtr found=IntPtr.Zero;EnumChildWindows(parent,(h,p)=>{if(GetDlgCtrlID(h)!=id)return true;found=h;return false;},IntPtr.Zero);return found;}
 public static IntPtr ExistingAccount(IntPtr dialog){var label=Control(dialog,10727);if(label==IntPtr.Zero||!IsWindowVisible(label))return IntPtr.Zero;var s=new StringBuilder(256);GetWindowText(label,s,256);if(s.ToString().Replace("&","")!="Connect with an existing trade account")return IntPtr.Zero;var button=Control(dialog,10469);if(button==IntPtr.Zero||!IsWindowVisible(button))return IntPtr.Zero;s.Clear();GetClassName(button,s,256);return s.ToString()=="Button"?button:IntPtr.Zero;}
 public static IntPtr Button(IntPtr parent,string label){IntPtr found=IntPtr.Zero;EnumChildWindows(parent,(h,p)=>{var name=new StringBuilder(256);GetClassName(h,name,256);if(name.ToString()!="Button"||!IsWindowVisible(h))return true;name.Clear();GetWindowText(h,name,256);if(!name.ToString().Replace("&","").StartsWith(label))return true;found=h;return false;},IntPtr.Zero);return found;}
 public static uint OpenAccount(IntPtr window){var menu=GetMenu(window);for(int i=0;i<GetMenuItemCount(menu);i++){var label=new StringBuilder(256);GetMenuString(menu,(uint)i,label,256,1024);if(label.ToString().Replace("&","")!="File")continue;var file=GetSubMenu(menu,i);for(int j=0;j<GetMenuItemCount(file);j++){label.Clear();GetMenuString(file,(uint)j,label,256,1024);if(label.ToString().Replace("&","").StartsWith("Open an Account"))return GetMenuItemID(file,j);}}return 0;}
}
'@
function Has-Server {
 if(-not(Test-Path -LiteralPath $servers)){return $false}
 $bytes=[IO.File]::ReadAllBytes($servers)
 return ([Text.Encoding]::Unicode.GetString($bytes).IndexOf($ExpectedServer,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or [Text.Encoding]::UTF8.GetString($bytes).IndexOf($ExpectedServer,[StringComparison]::OrdinalIgnoreCase) -ge 0)
}
$dialog=[IntPtr]::Zero;$phase='opening the broker directory';$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
try{
 if(Has-Server){Write-Output '{"discovered":true,"cached":true}';exit 0}
 $login=[CornGridBrokerDiscovery]::Window($ownedPid,'Login');if($login -ne [IntPtr]::Zero){[void][CornGridBrokerDiscovery]::PostMessage($login,273,[IntPtr]2,[IntPtr]::Zero);Start-Sleep -Milliseconds 300}
 $dialog=[CornGridBrokerDiscovery]::Window($ownedPid,'Open an Account')
 if($dialog -eq [IntPtr]::Zero){
  $command=0
  do{$window=[CornGridBrokerDiscovery]::Window($ownedPid,'terminal');$command=[CornGridBrokerDiscovery]::OpenAccount($window);if(-not $command){Start-Sleep -Milliseconds 250}}while(-not $command -and [DateTime]::UtcNow -lt $deadline)
  if(-not $command){throw 'English MT5 broker menu unavailable after startup.'};[void][CornGridBrokerDiscovery]::PostMessage($window,273,[IntPtr]$command,[IntPtr]::Zero)
  do{Start-Sleep -Milliseconds 250;$dialog=[CornGridBrokerDiscovery]::Window($ownedPid,'Open an Account')}while($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
 }
 if($dialog -eq [IntPtr]::Zero){throw 'Broker directory unavailable.'}
 $edit=[CornGridBrokerDiscovery]::Control($dialog,10814);$find=[CornGridBrokerDiscovery]::Control($dialog,10815)
 if($edit -eq [IntPtr]::Zero -or $find -eq [IntPtr]::Zero){throw 'Broker search controls unavailable.'}
  $phase='searching the broker directory';[void][CornGridBrokerDiscovery]::SendMessage($edit,12,[IntPtr]::Zero,$Search);[void][CornGridBrokerDiscovery]::PostMessage($find,245,[IntPtr]::Zero,[IntPtr]::Zero)
 $selected=$false;$searchedAt=Get-Date;$selectedAt=$null
 do{
  if(Has-Server){Write-Output '{"discovered":true,"cached":false}';exit 0}
  if(-not $selected -and ((Get-Date)-$searchedAt).TotalSeconds -ge 3 -and [CornGridBrokerDiscovery]::IsWindowEnabled($find)){
   # MT5 selects the new search result itself. Branding may differ from the
   # legal company name (e.g. Headway / Jarocel). Advance this first page only;
   # the requested canonical server must still be found before returning.
   $next=[CornGridBrokerDiscovery]::Button($dialog,'Next')
   if($next -ne [IntPtr]::Zero -and [CornGridBrokerDiscovery]::IsWindowEnabled($next)){[void][CornGridBrokerDiscovery]::PostMessage($next,245,[IntPtr]::Zero,[IntPtr]::Zero);$selected=$true;$selectedAt=Get-Date;$phase='loading the broker server metadata'}
  }
  $accountDialog=[CornGridBrokerDiscovery]::Window($ownedPid,'broker-account')
  if($selected -and $accountDialog -ne [IntPtr]::Zero){
   $dialog=$accountDialog;$phase='selecting the existing broker account'
   @{stage=$phase;controls=[CornGridBrokerDiscovery]::Labels($dialog)}|ConvertTo-Json -Depth 3|Set-Content -LiteralPath (Join-Path $directory 'config\broker-discovery-status.json') -Encoding UTF8
   do{$existing=[CornGridBrokerDiscovery]::ExistingAccount($dialog);if($existing -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 250}}while($existing -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
   if($existing -eq [IntPtr]::Zero){throw 'Existing account option unavailable'}
   [void][CornGridBrokerDiscovery]::PostMessage($existing,245,[IntPtr]::Zero,[IntPtr]::Zero);Start-Sleep -Milliseconds 300
   if([CornGridBrokerDiscovery]::Ptr($existing,240,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 1){throw 'Existing account option was not selected'}
   do{$combos=@([CornGridBrokerDiscovery]::Controls($dialog,'ComboBox'));$edits=@([CornGridBrokerDiscovery]::Controls($dialog,'Edit'));if($combos.Count -ne 1 -or $edits.Count -ne 2){Start-Sleep -Milliseconds 250}}while(($combos.Count -ne 1 -or $edits.Count -ne 2) -and [DateTime]::UtcNow -lt $deadline)
   if($combos.Count -ne 1 -or $edits.Count -ne 2){throw 'Unexpected existing account controls'}
   $observedNames=@([CornGridBrokerDiscovery]::Items($combos[0]))
   if(@($observedNames|Where-Object{$_ -notmatch '^[A-Za-z0-9 ._/-]{1,128}$'}).Count){throw 'Unexpected broker server name'}
   $index=-1;for($i=0;$i -lt $observedNames.Count;$i++){if($observedNames[$i] -ieq $ExpectedServer){$index=$i;break}}
   if($index -lt 0){throw 'Broker directory did not contain the requested canonical server.'}
   $privateStartup=[IO.File]::ReadAllText([IO.Path]::GetFullPath($StartupFile),[Text.Encoding]::Unicode)
   $login=([regex]::Match($privateStartup,'(?m)^Login=([^\r\n]+)')).Groups[1].Value
   $password=([regex]::Match($privateStartup,'(?m)^Password=([^\r\n]+)')).Groups[1].Value
   if($login -notmatch '^\d{1,32}$' -or -not $password){throw 'Existing account credentials missing'}
   [void][CornGridBrokerDiscovery]::Ptr($combos[0],334,[IntPtr]$index,[IntPtr]::Zero)
   [void][CornGridBrokerDiscovery]::PostMessage([CornGridBrokerDiscovery]::GetParent($combos[0]),273,[IntPtr]([CornGridBrokerDiscovery]::GetDlgCtrlID($combos[0]) -bor 65536),$combos[0])
   Start-Sleep -Milliseconds 200
   [void][CornGridBrokerDiscovery]::SendMessage($edits[0],12,[IntPtr]::Zero,$login)
   [void][CornGridBrokerDiscovery]::SendMessage($edits[1],12,[IntPtr]::Zero,$password)
   $finish=[CornGridBrokerDiscovery]::Button($dialog,'Finish');if($finish -eq [IntPtr]::Zero){throw 'Existing account confirmation unavailable'}
   [void][CornGridBrokerDiscovery]::PostMessage($finish,245,[IntPtr]::Zero,[IntPtr]::Zero)
   do{Start-Sleep -Milliseconds 250}while([CornGridBrokerDiscovery]::Window($ownedPid,'broker-account') -ne [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
   if([CornGridBrokerDiscovery]::Window($ownedPid,'broker-account') -ne [IntPtr]::Zero){throw 'Existing account login did not finish'}
   $dialog=[IntPtr]::Zero;Write-Output '{"discovered":true,"cached":false}';exit 0
  }
  Start-Sleep -Milliseconds 500
 }while([DateTime]::UtcNow -lt $deadline)
 throw 'Expected broker server was not discovered.'
}catch{@{stage=$phase;controls=if($dialog -ne [IntPtr]::Zero){[CornGridBrokerDiscovery]::Labels($dialog)}else{@()};observedNames=@($observedNames|Select-Object -Unique -First 35);reason=$_.Exception.Message}|ConvertTo-Json -Depth 3|Set-Content -LiteralPath (Join-Path $directory 'config\broker-discovery-status.json') -Encoding UTF8;Write-Error ('Broker discovery failed while '+$phase+'. Check broker name, node connectivity and the broker directory.');exit 1}
finally{if($dialog -ne [IntPtr]::Zero){$cancel=[CornGridBrokerDiscovery]::Control($dialog,2);if($cancel -ne [IntPtr]::Zero){[void][CornGridBrokerDiscovery]::PostMessage($cancel,245,[IntPtr]::Zero,[IntPtr]::Zero)}}
 Start-Sleep -Milliseconds 200
 $login=[CornGridBrokerDiscovery]::Window($ownedPid,'Login');if($login -ne [IntPtr]::Zero){$cancel=[CornGridBrokerDiscovery]::Control($login,2);if($cancel -ne [IntPtr]::Zero){[void][CornGridBrokerDiscovery]::PostMessage($cancel,245,[IntPtr]::Zero,[IntPtr]::Zero)}}
}
