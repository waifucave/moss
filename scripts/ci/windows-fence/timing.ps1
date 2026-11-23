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

# 5. The daemon's own exec, piece by piece, on a principal whose profile is there: the write-restricted token, a
#    write root held by a session (`acl grant --persistent --holder-pid`, then `--held-by`), and per-exec denies (each
#    one an ACE stamped before the logon and taken off after) at 20 and 200 paths.
$m3 = $pool[2].principal
Measure-Exec "exec cmd (warm-up for the rows below)" $m3 @($cmd, "/d", "/c", "exit 0")
$base = @("--quiet", "--user", $m3)
function Measure-Args([string]$Label, [string[]]$Extra) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & $Srt exec @base @Extra -- $cmd /d /c "exit 0" 2>&1
  $code = $LASTEXITCODE; $sw.Stop()
  Write-Output ("timing: {0} {1} ms (exit {2})" -f $Label, $sw.ElapsedMilliseconds, $code)
  if ($code -ne 0) { $out | Select-Object -First 5 | ForEach-Object { Write-Output "  $_" } }
}
Measure-Args "exec, write-restricted token" @("--write-restricted-token")
$probeDir = Join-Path $env:USERPROFILE "ws-timing"
New-Item -ItemType Directory -Force -Path (Join-Path $probeDir "root"), (Join-Path $probeDir "denied") | Out-Null
$files = 1..200 | ForEach-Object { $f = Join-Path $probeDir "denied\f$_.txt"; Set-Content -LiteralPath $f -Value x; $f }
$installed = (Get-ItemProperty "HKLM:\SOFTWARE\sandbox-runtime").SandboxUserSid
$sw = [Diagnostics.Stopwatch]::StartNew()
$doc = @{ read = @(); write = @((Join-Path $probeDir "root")) } | ConvertTo-Json -Compress
$doc | & $Srt acl grant --holder-pid $PID --sandbox-user-sid $installed --persistent 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Output "  $_" }
$sw.Stop(); Write-Output ("timing: acl grant --persistent, one root {0} ms (exit {1})" -f $sw.ElapsedMilliseconds, $LASTEXITCODE)
Measure-Args "exec, write root held by the session" @("--write-restricted-token", "--write-root", (Join-Path $probeDir "root"), "--held-by", "$PID")
foreach ($n in 20, 200) {
  $deny = @(); foreach ($f in ($files | Select-Object -First $n)) { $deny += "--deny-read"; $deny += $f }
  Measure-Args "exec, $n per-exec read denies" (@("--write-restricted-token", "--write-root", (Join-Path $probeDir "root"), "--held-by", "$PID") + $deny)
}
$sw = [Diagnostics.Stopwatch]::StartNew(); & $Srt acl revoke --holder-pid $PID --sandbox-user-sid $installed 2>&1 | Out-Null; $sw.Stop()
Write-Output ("timing: acl revoke {0} ms" -f $sw.ElapsedMilliseconds)
& $Srt acl forget --all 2>&1 | Out-Null
Remove-Item -Recurse -Force $probeDir -ErrorAction SilentlyContinue

# 6. The reset's delete for all four in ONE PowerShell process (the reset today starts one per member).
$sids = @($pool | ForEach-Object { (Get-LocalUser -Name $_.principal).SID.Value })
Measure-Step "delete all present profiles in one process" { foreach ($s in $sids) { Get-CimInstance Win32_UserProfile -Filter "SID='$s'" | Remove-CimInstance } }

# 7. The profile read grant (the daemon's first command pays it once), then once more.
Measure-Step "profile grant (first)" { & $Srt profile grant --quiet --json }
Measure-Step "profile grant (again)" { & $Srt profile grant --quiet --json }
Measure-Step "profile forget" { & $Srt profile forget }

Measure-Step "reset (all members, after the probe)" { & $Core sandbox reset }
foreach ($m in $pool) { Write-Output "timing-note: $($m.principal) profile left: $(Has-Profile $m.principal)" }
