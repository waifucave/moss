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

$m1 = $pool[0].principal; $m2 = $pool[1].principal
# Setup leaves every principal with a profile; the first rows want none.
foreach ($m in $m1, $m2) { $s = (Get-LocalUser -Name $m).SID.Value; Get-CimInstance Win32_UserProfile -Filter "SID='$s'" | Remove-CimInstance }

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


# 6b. Lane WS7: where a read deny's cost comes from. srt-win stamps a deny on the target and a FILE_DELETE_CHILD deny on
#     its parent, each written with SetSecurityInfo, which carries inheritable entries down the whole tree below: a
#     target in the home's top level puts that write on the home itself. Measured on new folders, without the profile
#     grant here and with it below, at the home's top, one level down, deep under a small folder, and outside the home.
function Measure-Deny([string]$Label, [string]$Path, [string]$Flag = "--deny-read") {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & $Srt exec --user $m3 --write-restricted-token $Flag $Path -- $cmd /d /c "exit 0" 2>&1
  $sw.Stop()
  Write-Output ("timing: {0} {1} ms (exit {2}); {3}" -f $Label, $sw.ElapsedMilliseconds, $LASTEXITCODE, (($out | Where-Object { "$_" -like "srt-win:*" }) -join " | "))
}
$homeCount = (Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output "timing-note: the home holds $homeCount entries"
$where = @(
  @("a new folder at the home's top", (Join-Path $env:USERPROFILE "ws7-new-top")),
  @("a new folder one level down (Documents)", (Join-Path $env:USERPROFILE "Documents\ws7-new-doc")),
  @("a new folder deep under a small folder", (Join-Path $env:USERPROFILE "ws7-small\a\b\c")),
  @("a new folder outside the home", "C:\ws7-outside\x")
)
foreach ($w in $where) { Measure-Deny "exec, one read deny on $($w[0]), no profile grant" $w[1] }
Measure-Deny "exec, one write deny on a new folder at the home's top, no profile grant" (Join-Path $env:USERPROFILE "ws7-new-top-w") "--deny-write"

# 7. The profile read grant (the daemon's first command pays it once), then once more.
Measure-Step "profile grant (first)" { & $Srt profile grant --quiet --json }
Measure-Step "profile grant (again)" { & $Srt profile grant --quiet --json }
# A per-exec read deny under the profile read grant is also stamped on every recorded allow beneath it (srt-win's
# deny expansion): what that costs on the home's dot-folders and AppData, with the grant in place.
foreach ($d in @("AppData", ".ssh")) {
  $p = Join-Path $env:USERPROFILE $d; New-Item -ItemType Directory -Force -Path $p | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & $Srt exec --user $m3 --write-restricted-token --deny-read $p -- $cmd /d /c "exit 0" 2>&1
  $sw.Stop()
  Write-Output ("timing: exec, one read deny on ~\{0} with the profile grant {1} ms (exit {2}); {3}" -f $d, $sw.ElapsedMilliseconds, $LASTEXITCODE, (($out | Where-Object { "$_" -like "srt-win:*" }) -join " | "))
}
foreach ($w in $where) { Measure-Deny "exec, one read deny on $($w[0]), with the profile grant" "$($w[1])-g" }
Measure-Deny "exec, one write deny on a new folder at the home's top, with the profile grant" (Join-Path $env:USERPROFILE "ws7-new-top-wg") "--deny-write"
foreach ($w in $where) { Remove-Item -Recurse -Force -LiteralPath $w[1], "$($w[1])-g" -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force -LiteralPath (Join-Path $env:USERPROFILE "ws7-new-top-w"), (Join-Path $env:USERPROFILE "ws7-new-top-wg"), (Join-Path $env:USERPROFILE "ws7-small"), "C:\ws7-outside" -ErrorAction SilentlyContinue
Measure-Step "profile forget" { & $Srt profile forget }

# 6c. Lane WS7, an assertion, not a timing: patch 0004 writes the parent's FILE_DELETE_CHILD deny on the parent alone,
#     and a write-denied target carries its own inheritable one. A delete is granted by the parent's FILE_DELETE_CHILD
#     whatever the child's own DELETE says, so here every object grants that right (Everyone, full control, inherited)
#     and a fenced command, with a write deny (and then a read deny) on `t`, tries to rename or move away and to delete a
#     file in `t`, a file in `t\sub`, `t\sub` and `t`: each must still be there. The open sibling's file is the
#     control: the same command deletes it, or the probe proves nothing. Run with the daemon's write-restricted token as
#     well (its control shown).
$fdcRoot = "C:\ws7-fdc"; $fdcRun = "C:\ws7-fdc-run"; $guardBroken = $false
New-Item -ItemType Directory -Force -Path $fdcRun | Out-Null
Set-Content -LiteralPath (Join-Path $fdcRun "probe.cmd") -Value @(
  "@echo off",
  "del /q $fdcRoot\open\f.txt 2>nul",
  "move /y $fdcRoot\t\f.txt $fdcRoot\open\moved-f.txt >nul 2>nul",
  "move /y $fdcRoot\t\sub $fdcRoot\open\moved-sub >nul 2>nul",
  "ren $fdcRoot\t\sub\g.txt g2.txt 2>nul",
  "ren $fdcRoot\t t2 2>nul",
  "del /q $fdcRoot\t\f.txt 2>nul",
  "del /q $fdcRoot\t\sub\g.txt 2>nul",
  "rd /s /q $fdcRoot\t\sub 2>nul",
  "rd /s /q $fdcRoot\t 2>nul",
  "exit 0"
)
& icacls.exe $fdcRun /grant "*S-1-1-0:(OI)(CI)RX" | Out-Null
foreach ($case in @(@("--deny-write", @()), @("--deny-read", @()), @("--deny-write", @("--write-restricted-token")))) {
  Remove-Item -Recurse -Force -LiteralPath $fdcRoot -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $fdcRoot "t\sub"), (Join-Path $fdcRoot "open") | Out-Null
  & icacls.exe $fdcRoot /grant "*S-1-1-0:(OI)(CI)F" | Out-Null
  foreach ($f in "t\f.txt", "t\sub\g.txt", "open\f.txt") { Set-Content -LiteralPath (Join-Path $fdcRoot $f) -Value x }
  $flag = $case[0]; $extra = @($case[1])
  $out = & $Srt exec --user $m3 @extra $flag (Join-Path $fdcRoot "t") -- $cmd /d /c (Join-Path $fdcRun "probe.cmd") 2>&1
  $code = $LASTEXITCODE
  $kept = @("t\f.txt", "t\sub\g.txt", "t\sub", "t" | Where-Object { Test-Path -LiteralPath (Join-Path $fdcRoot $_) })
  $control = -not (Test-Path -LiteralPath (Join-Path $fdcRoot "open\f.txt"))
  $label = "$flag$(if ($extra.Count) { ' ' + ($extra -join ' ') })"
  $moved = @("open\moved-f.txt", "open\moved-sub", "t\sub\g2.txt", "t2" | Where-Object { Test-Path -LiteralPath (Join-Path $fdcRoot $_) })
  Write-Output ("delete-guard: {0}: exit {1}; still there: {2} of 4 ({3}); moved or renamed: {4}; the open sibling's file deleted: {5}" -f $label, $code, $kept.Count, ($kept -join ", "), $(if ($moved.Count) { $moved -join ", " } else { "none" }), $control)
  if ($code -ne 0) { $out | Select-Object -First 5 | ForEach-Object { Write-Output "  $_" } }
  if ($kept.Count -ne 4 -or $moved.Count -ne 0) { $guardBroken = $true; Write-Output "delete-guard: FAILED: a fenced command deleted, moved or renamed under $label" }
  if (-not $extra.Count -and -not $control) { $guardBroken = $true; Write-Output "delete-guard: FAILED: the control was not deleted, so the probe proves nothing ($label)" }
}
Remove-Item -Recurse -Force -LiteralPath $fdcRoot, $fdcRun -ErrorAction SilentlyContinue

# The probe used every principal: all marked used, then the reset (elevated here; the task runs it as SYSTEM) remakes
# them all, so the end-to-end suite starts on a pool as the daemon finds it.
$poolState = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\pool\$Sid"
foreach ($m in $pool) { Set-Content -NoNewline -LiteralPath (Join-Path $poolState "$($m.principal).used") -Value (Get-Content -Raw -LiteralPath (Join-Path $poolState "$($m.principal).gen")).Trim() }
Measure-Step "reset: remake all four used principals (one process)" { & $Core sandbox reset }
foreach ($m in $pool) { Write-Output "timing-note: $($m.principal) profile after the reset: $(Has-Profile $m.principal)" }
# 6c above failed: after the reset, so the end-to-end suite still finds the pool as the daemon does.
if ($guardBroken) { Write-Output "delete-guard: FAILED (see above)"; exit 1 }
