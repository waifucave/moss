# Where a fenced command's time goes on this runner, step by step, outside the daemon: the launcher's logon on a
# principal with no profile (what every command does today) against one whose profile exists, the shells' own start,
# a profile made ahead by Windows' CreateProfile (no logon), the reset's delete, and the profile read grant. Prints
# one "timing:" line per measurement (milliseconds). Leaves every principal reset, as the end-to-end suite expects.
. "$PSScriptRoot/lib.ps1"
$pool = @(Get-Pool)
$sys = [Environment]::GetFolderPath("System")
$cmd = Join-Path $sys "cmd.exe"
$ps = Join-Path $sys "WindowsPowerShell\v1.0\powershell.exe"
$bash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"

function Measure-Exec([string]$Label, [string]$User, [string[]]$Child) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & $Srt exec --quiet --user $User -- @Child 2>&1
  $code = $LASTEXITCODE
  $sw.Stop()
  Write-Output ("timing: {0} {1} ms (exit {2})" -f $Label, $sw.ElapsedMilliseconds, $code)
  if ($code -ne 0) { $out | Select-Object -First 5 | ForEach-Object { Write-Output "  $_" } }
}
function Measure-Step([string]$Label, [scriptblock]$Block) {
  $sw = [Diagnostics.Stopwatch]::StartNew(); & $Block | Out-Null; $sw.Stop()
  Write-Output ("timing: {0} {1} ms" -f $Label, $sw.ElapsedMilliseconds)
}
function Has-Profile([string]$Name) {
  $s = (Get-LocalUser -Name $Name).SID.Value
  Test-Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$s"
}

Measure-Step "reset (all members, elevated, from setup's warm-up profiles)" { & $Core sandbox reset }
$m1 = $pool[0].principal; $m2 = $pool[1].principal

# 1. The launcher on a principal with no profile: the logon makes one from the default profile.
Measure-Exec "exec cmd, no profile (fresh logon)" $m1 @($cmd, "/d", "/c", "exit 0")
Write-Output "timing-note: $m1 profile after: $(Has-Profile $m1)"
# 2. The same principal again, its profile there.
Measure-Exec "exec cmd, profile there (1)" $m1 @($cmd, "/d", "/c", "exit 0")
Measure-Exec "exec cmd, profile there (2)" $m1 @($cmd, "/d", "/c", "exit 0")
Measure-Exec "exec bash -c true, profile there" $m1 @($bash, "-c", "true")
Measure-Exec "exec powershell exit, profile there" $m1 @($ps, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0")
# 3. The reset's delete of one profile.
$s1 = (Get-LocalUser -Name $m1).SID.Value
Measure-Step "delete one profile (Win32_UserProfile)" { Get-CimInstance Win32_UserProfile -Filter "SID='$s1'" | Remove-CimInstance }

# 4. A profile made ahead with userenv's CreateProfile (as the reset task could, SYSTEM, no logon), then the logon.
Add-Type -Namespace Moss -Name UserEnv -MemberDefinition @'
[DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int CreateProfile(string sid, string name, System.Text.StringBuilder path, uint len);
'@
$s2 = (Get-LocalUser -Name $m2).SID.Value
$sb = New-Object System.Text.StringBuilder 260
$sw = [Diagnostics.Stopwatch]::StartNew(); $hr = [Moss.UserEnv]::CreateProfile($s2, $m2, $sb, 260); $sw.Stop()
Write-Output ("timing: CreateProfile ahead {0} ms (hr 0x{1:X8}, {2})" -f $sw.ElapsedMilliseconds, $hr, $sb.ToString())
Measure-Exec "exec cmd, profile made ahead by CreateProfile" $m2 @($cmd, "/d", "/c", "exit 0")
Measure-Exec "exec cmd, after that" $m2 @($cmd, "/d", "/c", "exit 0")

# 5. The profile read grant (the daemon's first command pays it once), then once more.
Measure-Step "profile grant (first)" { & $Srt profile grant --quiet --json }
Measure-Step "profile grant (again)" { & $Srt profile grant --quiet --json }
Measure-Step "profile forget" { & $Srt profile forget }

Measure-Step "reset (all members, after the probe)" { & $Core sandbox reset }
foreach ($m in $pool) { Write-Output "timing-note: $($m.principal) profile left: $(Has-Profile $m.principal)" }
