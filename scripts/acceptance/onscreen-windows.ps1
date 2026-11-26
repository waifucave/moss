# The on-screen top-level windows on Windows, one JSON object a line: owner pid, opacity (0..1; 1 when the window is not layered) and size.
# Never titles. The counterpart of onscreen-windows.swift (macOS) and the X11 read (Linux): host-step.ts `onscreenWindows` runs it.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Onscreen {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static List<string> List() {
    var o = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      double a = 1.0;
      if ((GetWindowLong(h, -20) & 0x80000) != 0) { uint k, f; byte al; if (GetLayeredWindowAttributes(h, out k, out al, out f) && (f & 2) != 0) a = al / 255.0; }
      o.Add("{\"pid\":" + pid + ",\"alpha\":" + a.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
[Onscreen]::List() | ForEach-Object { $_ }
