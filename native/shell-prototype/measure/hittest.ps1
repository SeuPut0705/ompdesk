# hittest.ps1 -ProcessId <pid> [-X 400] [-Y 20]: WM_NCHITTEST at client point (X, Y) of the process's main visible
# top-level window, sent to that window and to the deepest child under the point (no cursor moves). 2 = HTCAPTION,
# 1 = HTCLIENT, 8/9/20 = min/max/close buttons, -1 = HTTRANSPARENT. Also probes the caption-button corner.
param([int]$ProcessId, [int]$X = 400, [int]$Y = 20)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Hit {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint f);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  public struct POINT { public int X, Y; } public struct RECT { public int L, T, R, B; }
  public static IntPtr Top(uint pid) { IntPtr best = IntPtr.Zero; int area = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); RECT r;
      if (p == pid && IsWindowVisible(h) && GetWindowRect(h, out r)) { int a = (r.R-r.L)*(r.B-r.T); if (a > area) { area = a; best = h; } } return true; }, IntPtr.Zero);
    return best; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static long Probe(IntPtr h, int sx, int sy) { return (long)SendMessage(h, 0x84, IntPtr.Zero, (IntPtr)(((sy & 0xFFFF) << 16) | (sx & 0xFFFF))); }
  public static IntPtr Deepest(IntPtr top, POINT screen) { IntPtr cur = top; for (int i = 0; i < 10; i++) { POINT c = screen; ScreenToClient(cur, ref c);
    IntPtr ch = ChildWindowFromPointEx(cur, c, 1|4); if (ch == IntPtr.Zero || ch == cur) break; cur = ch; } return cur; }
}
"@
$h = [Hit]::Top([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { '{"error":"no visible window"}'; exit 1 }
$rect = New-Object Hit+RECT; [void][Hit]::GetClientRect($h, [ref]$rect)
$style = [Hit]::GetWindowLong($h, -16)
$points = @(@{name='topbar'; x=$X; y=$Y}, @{name='content'; x=$X; y=300}, @{name='closeCorner'; x=$rect.R-23; y=20}, @{name='maxCorner'; x=$rect.R-69; y=20})
$out = foreach ($pt in $points) {
  $p = New-Object Hit+POINT; $p.X = $pt.x; $p.Y = $pt.y; [void][Hit]::ClientToScreen($h, [ref]$p)
  $child = [Hit]::Deepest($h, $p)
  [pscustomobject]@{ point=$pt.name; client="$($pt.x),$($pt.y)"; top=[Hit]::Probe($h, $p.X, $p.Y); child=[Hit]::Cls($child); childHit=[Hit]::Probe($child, $p.X, $p.Y) }
}
[pscustomobject]@{ window=[Hit]::Cls($h); clientWidth=$rect.R; hasCaptionStyle=(($style -band 0x00C00000) -eq 0x00C00000); probes=$out } | ConvertTo-Json -Compress -Depth 4
if ($env:HIT_SCAN) {
  $hits = @{}
  for ($y = 2; $y -lt 60; $y += 6) { for ($x = 0; $x -lt $rect.R; $x += 20) {
    $p = New-Object Hit+POINT; $p.X = $x; $p.Y = $y; [void][Hit]::ClientToScreen($h, [ref]$p)
    $r = [Hit]::Probe($h, $p.X, $p.Y); $k = "$r"; if (-not $hits.ContainsKey($k)) { $hits[$k] = @() }; $hits[$k] += "$x,$y" } }
  $hits.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value.Count) points, first $($_.Value[0]) last $($_.Value[-1])" }
}
