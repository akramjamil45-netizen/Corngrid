param([switch]$Capture,[string]$Keys,[string]$ClipboardCommandPath,[string]$TypeCommandPath,[switch]$ReadResult,[switch]$Interrupt,[switch]$OpenRun,[int]$ClickX=-1,[int]$ClickY=-1,[int]$RdpProcessId=7324,[string]$RdpAddress='188.42.230.32:3388',[ValidatePattern('^[A-Za-z0-9._-]+\.png$')][string]$ScreenshotName='remote-sandbox-desktop.png')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CornGridRdpWindow {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct KEYBOARD { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit,Size=32)] public struct DATA { [FieldOffset(0)] public KEYBOARD keyboard; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public DATA data; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern short VkKeyScan(char character);
 [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint key,uint type);
 public static void Scan(ushort code,bool up){var input=new INPUT();input.type=1;input.data.keyboard.scan=code;input.data.keyboard.flags=8u|(up?2u:0u);if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Windows rejected keyboard injection.");}
 public static void Extended(ushort code,bool up){var input=new INPUT();input.type=1;input.data.keyboard.scan=code;input.data.keyboard.flags=9u|(up?2u:0u);if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Windows rejected keyboard injection.");}
 public static void Key(byte vk,bool up){keybd_event(vk,(byte)MapVirtualKey(vk,0),up?2u:0u,UIntPtr.Zero);}
 public static void TypeAscii(string text){foreach(char c in text){short key=VkKeyScan(c);if(key<0||((key>>8)&~1)!=0)throw new Exception("Unsupported command character.");bool shift=((key>>8)&1)!=0;if(shift){Key(0x10,false);System.Threading.Thread.Sleep(35);}Key((byte)(key&255),false);System.Threading.Thread.Sleep(8);Key((byte)(key&255),true);if(shift){System.Threading.Thread.Sleep(20);Key(0x10,true);}System.Threading.Thread.Sleep(8);}}
}
'@
$rdp=Get-Process -Id $RdpProcessId -ErrorAction Stop
if($rdp.ProcessName -ne 'mstsc' -or $rdp.MainWindowTitle.IndexOf($RdpAddress,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'The intended VPS Remote Desktop session is no longer available.'}
if($ReadResult){
 $value=[Windows.Forms.Clipboard]::GetText()
 if(-not $value.StartsWith('CORNGRID_REMOTE_RESULT:')){throw 'No task result is available in the redirected clipboard.'}
 $value.Substring('CORNGRID_REMOTE_RESULT:'.Length)
 exit
}
if([CornGridRdpWindow]::IsIconic($rdp.MainWindowHandle)){[void][CornGridRdpWindow]::ShowWindow($rdp.MainWindowHandle,9)}
$shell=New-Object -ComObject WScript.Shell
[void]$shell.AppActivate($rdp.Id)
[void][CornGridRdpWindow]::SetForegroundWindow($rdp.MainWindowHandle)
Start-Sleep -Milliseconds 700
if([CornGridRdpWindow]::GetForegroundWindow() -ne $rdp.MainWindowHandle){throw 'Remote Desktop could not be focused. No keys were sent.'}
if($ClickX -ge 0 -and $ClickY -ge 0){
 $clickBounds=New-Object CornGridRdpWindow+RECT
 if(-not [CornGridRdpWindow]::GetWindowRect($rdp.MainWindowHandle,[ref]$clickBounds)){throw 'Cannot locate the intended RDP window.'}
 if($ClickX -ge ($clickBounds.Right-$clickBounds.Left) -or $ClickY -ge ($clickBounds.Bottom-$clickBounds.Top)){throw 'Click is outside the RDP window.'}
 [void][CornGridRdpWindow]::SetCursorPos($clickBounds.Left+$ClickX,$clickBounds.Top+$ClickY)
 [CornGridRdpWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 100;[CornGridRdpWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 400
}
if($Interrupt){
 try{[CornGridRdpWindow]::Key(0x11,$false);Start-Sleep -Milliseconds 200;[CornGridRdpWindow]::Key(0x43,$false);Start-Sleep -Milliseconds 150;[CornGridRdpWindow]::Key(0x43,$true)}finally{[CornGridRdpWindow]::Key(0x11,$true)}
 Start-Sleep -Seconds 2
}
if($OpenRun){
 try{[CornGridRdpWindow]::Extended(0x5b,$false);Start-Sleep -Milliseconds 150;[CornGridRdpWindow]::Scan(0x13,$false);Start-Sleep -Milliseconds 150;[CornGridRdpWindow]::Scan(0x13,$true)}finally{[CornGridRdpWindow]::Extended(0x5b,$true)}
 Start-Sleep -Seconds 2
}
if($Keys){$shell.SendKeys($Keys);Start-Sleep -Milliseconds 900}
if($TypeCommandPath){
 $workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$typedPath=[IO.Path]::GetFullPath($TypeCommandPath)
 if(-not $typedPath.StartsWith($workspaceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Command must be a reviewed file inside this workspace.'}
 $typedCommand=[IO.File]::ReadAllText($typedPath).Trim()
 [CornGridRdpWindow]::TypeAscii($typedCommand)
 [CornGridRdpWindow]::Key(0x0d,$false);[CornGridRdpWindow]::Key(0x0d,$true)
 Start-Sleep -Seconds 2
}
if($ClipboardCommandPath){
 $workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
 $commandPath=[IO.Path]::GetFullPath($ClipboardCommandPath)
 if(-not $commandPath.StartsWith($workspaceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Command must be a reviewed file inside this workspace.'}
 $command=[IO.File]::ReadAllText($commandPath)
 [Windows.Forms.Clipboard]::SetText($command)
 Start-Sleep -Milliseconds 900
 try{
  [CornGridRdpWindow]::Key(0x11,$false)
  Start-Sleep -Milliseconds 150
  [CornGridRdpWindow]::Key(0x56,$false)
  Start-Sleep -Milliseconds 150
  [CornGridRdpWindow]::Key(0x56,$true)
 }finally{[CornGridRdpWindow]::Key(0x11,$true)}
 Start-Sleep -Milliseconds 500
 [CornGridRdpWindow]::Key(0x0d,$false);[CornGridRdpWindow]::Key(0x0d,$true)
 Start-Sleep -Milliseconds 1200
}
if($Capture){
 $bounds=New-Object CornGridRdpWindow+RECT
 if(-not [CornGridRdpWindow]::GetWindowRect($rdp.MainWindowHandle,[ref]$bounds)){throw 'Cannot locate Remote Desktop window.'}
 $screen=[Windows.Forms.SystemInformation]::VirtualScreen
 $left=[Math]::Max($screen.Left,$bounds.Left);$top=[Math]::Max($screen.Top,$bounds.Top)
 $right=[Math]::Min($screen.Right,$bounds.Right);$bottom=[Math]::Min($screen.Bottom,$bounds.Bottom)
 $bitmap=New-Object Drawing.Bitmap(($right-$left),($bottom-$top))
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 try{$graphics.CopyFromScreen($left,$top,0,0,$bitmap.Size);$bitmap.Save((Join-Path $PSScriptRoot $ScreenshotName))}finally{$graphics.Dispose();$bitmap.Dispose()}
 Write-Output 'Remote Desktop screenshot saved.'
}
