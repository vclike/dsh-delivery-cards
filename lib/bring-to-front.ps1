# dsh-delivery-cards - bring the Explorer window for one folder to the FRONT.
#
# ASCII ONLY. Do not add non-ASCII characters to this file: this host runs
# Windows PowerShell 5.1, which reads a BOM-less .ps1 as ANSI and mangles CJK
# text badly enough to break parsing of the following statements.
#
# WHY THIS EXISTS (measured 2026-09-13):
#   The Host spawns `explorer.exe /select,<path>` with windowsHide=false, so the
#   window IS created visible - but it NEVER takes the foreground. The user sees
#   it "open behind the browser" (regardless of the browser window size) and
#   concludes nothing happened.
#
# FOREGROUND (measured, all from a background process):
#   ShowWindow(SW_RESTORE)                   -> SetForegroundWindow still denied
#   SetWindowPos(TOPMOST then NOTOPMOST)     -> denied
#   AttachThreadInput + SetForegroundWindow  -> returned False
#   SwitchToThisWindow                       -> denied
#   ALT keystroke injection + SetForegroundWindow -> WORKS (returns True)
# The ALT down/up makes this process "the one that last received input", which is
# exactly the condition Windows requires to grant foreground rights.
#
# FINDING THE WINDOW - DO NOT USE Shell.Application HERE:
#   Enumerating `Shell.Application.Windows()` while Explorer is still creating the
#   new window BLOCKS (measured: one round took 6.3s and blew the timeout). Use
#   native EnumWindows + GetClassName/GetWindowText instead - no COM, no blocking.
#   Match: class CabinetWClass, title contains the folder leaf. Titles are
#   "<folder> - <localized File Explorer>", so only the folder prefix is matched.
#
# Usage: powershell -File bring-to-front.ps1 -Target <absolute file path> [-TimeoutMs 6000]
# Exit codes: 0 = window found and fronted, 3 = no matching window, 4 = Add-Type failed.

param(
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$TimeoutMs = 6000
)

$ErrorActionPreference = 'SilentlyContinue'

if ([string]::IsNullOrEmpty($env:DSH_HOME)) { $homeDir = 'D:\dsh\home' } else { $homeDir = $env:DSH_HOME }
$logPath = Join-Path $homeDir 'cache\dsh-delivery-cards-bring.log'

function Blog($m) {
  $line = "$(Get-Date -Format 'HH:mm:ss.fff')  $m"
  Write-Output $line
  try {
    $dir = Split-Path -Parent $logPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch { }
}

Blog "START pid=$PID target=$Target timeout=$TimeoutMs"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class DdcFront {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  private static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  private static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }

  public static string TitleOf(IntPtr h) { return Title(h); }
  public static bool IsFg(IntPtr h) { return GetForegroundWindow() == h; }

  // Topmost Explorer window whose title contains the folder leaf. EnumWindows
  // walks top-to-bottom, and the window that was just opened sits at the top of
  // the z-order, so the first match is the one we want.
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    string want = needle.ToLowerInvariant();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (Cls(h) != "CabinetWClass") return true;
      string t = Title(h);
      if (t.Length == 0) return true;
      if (t.ToLowerInvariant().IndexOf(want) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'DdcFront').Type) {
  Blog 'FAIL Add-Type unavailable'
  exit 4
}
Blog 'Add-Type ok'

$needle = Split-Path -Leaf (Split-Path -Parent $Target)
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$round = 0

while ((Get-Date) -lt $deadline) {
  $round++
  $t0 = Get-Date
  $h = [DdcFront]::Find($needle)
  $scanMs = [int]((Get-Date) - $t0).TotalMilliseconds
  if ($h -ne [IntPtr]::Zero) {
    $visBefore = [DdcFront]::IsWindowVisible($h)
    $icoBefore = [DdcFront]::IsIconic($h)
    [void][DdcFront]::ShowWindow($h, 5)
    [void][DdcFront]::ShowWindow($h, 1)
    [void][DdcFront]::ShowWindow($h, 9)
    [void][DdcFront]::BringWindowToTop($h)
    # Foreground-lock bypass: the ALT down/up makes this process the one that
    # last received input, which is what Windows requires to grant foreground.
    [DdcFront]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [DdcFront]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    $fg = [DdcFront]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 200
    $isFg = [DdcFront]::IsFg($h)
    $title = [DdcFront]::TitleOf($h)
    Blog "HIT round=$round scanMs=$scanMs hwnd=$h title=[$title] visBefore=$visBefore iconicBefore=$icoBefore setFg=$fg isForeground=$isFg iconicAfter=$([DdcFront]::IsIconic($h))"
    if ($fg -or $isFg) { exit 0 }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 150
}
Blog "TIMEOUT rounds=$round needle=$needle"
exit 3
