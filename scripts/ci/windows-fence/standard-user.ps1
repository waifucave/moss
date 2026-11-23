# The daemon as it runs for real on Windows: a standard (non-admin) user, started by its startup task with the user's
# password ("run whether the user is logged on or not"), which puts it in Session 0 with a password logon (spec §14.1
# item 2: the Session 0 launch and the password-principal startup task). An administrator sets the sandbox up for
# that user from the user's protected copy; the user's own unelevated `sandbox setup` must say it needs elevation
# (exit 2); then the fenced end-to-end suite runs inside the user's task, and the administrator removes the sandbox.
# The user and its password are made here, for this job alone; the password is never printed or written.
. "$PSScriptRoot/lib.ps1"
$name = "mossowner"
$bytes = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$plain = "Aa1!" + [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
Add-LocalGroupMember -Group "Users" -Member $name -ErrorAction SilentlyContinue
$ownerSid = (Get-LocalUser -Name $name).SID.Value
# Log on as a batch job, which a password task needs.
$inf = Join-Path $env:RUNNER_TEMP "batch.inf"; $db = Join-Path $env:RUNNER_TEMP "batch.sdb"
& secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
$lines = Get-Content $inf
$lines = $lines | ForEach-Object { if ($_ -match '^SeBatchLogonRight') { "$_,*$ownerSid" } else { $_ } }
if (-not ($lines -match '^SeBatchLogonRight')) { $lines = $lines -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`nSeBatchLogonRight = *$ownerSid" }
Set-Content -Path $inf -Value $lines
& secedit /configure /db $db /cfg $inf /areas USER_RIGHTS | Out-Null

$ci = "C:\moss-ci"
New-Item -ItemType Directory -Force -Path $ci | Out-Null
& icacls $ci /grant "*${ownerSid}:(OI)(CI)M" | Out-Null
Copy-Item -Force (Get-Command bun).Source (Join-Path $ci "bun.exe")
$bun = Join-Path $ci "bun.exe"

# A task as the user, with its password: Session 0, a password logon, the user's profile loaded. Waits for it.
function Invoke-AsUser([string]$Label, [string[]]$Lines, [int]$Seconds = 1800) {
  $cmd = Join-Path $ci "$Label.cmd"; $log = Join-Path $ci "$Label.log"
  Set-Content -Path $cmd -Encoding ascii -Value (@("@echo off") + $Lines)
  $task = "moss-ci-$Label"
  # No spaces in either path: cmd's /c quoting stays out of it.
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c $cmd > $log 2>&1"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds $Seconds) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -User $name -Password $plain -RunLevel Limited -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddSeconds($Seconds + 60)
  do { Start-Sleep -Seconds 5; $info = Get-ScheduledTaskInfo -TaskName $task; $state = (Get-ScheduledTask -TaskName $task).State } while ($state -eq "Running" -and (Get-Date) -lt $deadline)
  Write-Host "== $Label (as $name, task result $($info.LastTaskResult))"
  if (Test-Path $log) { Get-Content $log | Write-Host }
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  return $info.LastTaskResult
}

# The user's own process in this (interactive) session, as the login item MOSS registers starts it (an InteractiveToken
# task at the user's logon): seclogon with the user's password, its profile loaded, unelevated.
function Invoke-AsUserHere([string]$Label, [string[]]$Lines, [int]$Seconds = 1800) {
  $cmd = Join-Path $ci "$Label.cmd"; $log = Join-Path $ci "$Label.log"
  Set-Content -Path $cmd -Encoding ascii -Value (@("@echo off") + $Lines)
  $cred = New-Object System.Management.Automation.PSCredential($name, $secure)
  $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /c $cmd > $log 2>&1" -Credential $cred -LoadUserProfile -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit($Seconds * 1000)) { & taskkill.exe /T /F /PID $p.Id | Out-Null }
  Write-Host "== $Label (as $name, in this session, exit $($p.ExitCode))"
  if (Test-Path $log) { Get-Content $log | Write-Host }
}

# The user's profile (its first logon), and where the task runs.
$probe = "powershell -NoProfile -Command `"'session: ' + (Get-Process -Id `$PID).SessionId + ' admin: ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')`""
$code = Invoke-AsUser "whoami" @("whoami", $probe) 300
if ($code -ne 0) { throw "the user's first task failed ($code)" }

# The user's protected copy, set up by the administrator (lane M's installer does this with UAC).
$prot = Join-Path ([Environment]::GetFolderPath("ProgramFiles")) "MOSS Sandbox\$ownerSid"
New-Item -ItemType Directory -Force -Path $prot | Out-Null
Copy-Item -Force (Join-Path $Root "dist/daemon/windows-x64/moss-core.exe") (Join-Path $prot "moss-core.exe")
Copy-Item -Force (Join-Path $Root "vendor/srt-win/srt-win.exe") (Join-Path $prot "srt-win.exe")
$ucore = Join-Path $prot "moss-core.exe"

# Unelevated, the user's own setup says what it needs: exit 2, "needs elevation".
$code = Invoke-AsUser "setup-unelevated" @("`"$ucore`" sandbox setup", "echo exit=%ERRORLEVEL%") 300
$text = Get-Content (Join-Path $ci "setup-unelevated.log") -Raw
if ($text -notmatch "needs elevation" -or $text -notmatch "exit=2") { throw "an unelevated setup didn't refuse with exit 2 and the reason" }

$code = Invoke-Limited "setup for $name, by the administrator" $ucore @("sandbox", "setup") 900
if ($code -ne 0) { throw "setup for the standard user exited $code" }
# The pool's state as the owner sees it (`poolStateDir`): it may read a generation and write its used record, and may
# neither write a generation nor make a file of its own (no link can be planted where the SYSTEM reset opens files).
$pool1 = (Get-LocalUser | Where-Object Name -like "moss-sb-*" | Sort-Object Name | Select-Object -First 1).Name
$pdir = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\pool\$ownerSid"
$perm = "powershell -NoProfile -Command `"" +
  "`$d='$pdir'; " +
  "'read-gen=' + [bool](Get-Content -Raw -LiteralPath (Join-Path `$d '$pool1.gen') -ErrorAction SilentlyContinue); " +
  "try { [IO.File]::WriteAllText((Join-Path `$d '$pool1.used'), 'x'); 'write-used=True' } catch { 'write-used=False' }; " +
  "try { [IO.File]::WriteAllText((Join-Path `$d '$pool1.gen'), 'x'); 'write-gen=True' } catch { 'write-gen=False' }; " +
  "try { [IO.File]::WriteAllText((Join-Path `$d 'planted.lock'), 'x'); 'make-file=True' } catch { 'make-file=False' }`""
$null = Invoke-AsUser "pool-perms" @($perm) 300
$pp = Get-Content (Join-Path $ci "pool-perms.log") -Raw
if ($pp -notmatch "read-gen=True" -or $pp -notmatch "write-used=True" -or $pp -notmatch "write-gen=False" -or $pp -notmatch "make-file=False") { throw "the owner's rights on the pool's state aren't read-gen, write-used only: $pp" }
# The used record just written ("x") is no generation: the principal stays fresh for the suite below.

# The fenced suite in the user's own task: an unelevated daemon in Session 0.
$e2e = @(
  "cd /d `"$Root\packages\core`"",
  "set MOSS_WIN_FENCE_E2E=1",
  "set MOSS_WIN_FENCE_TIMING=1",
  $probe,
  "`"$bun`" test --timeout 900000 test/fence/win-fenced.e2e.test.ts",
  "echo exit=%ERRORLEVEL%"
)
# 1. As the login item runs it: the user's interactive session.
# Start-Process -Credential hands the child this (administrator's) environment block: the user's own folders are set
# here, as a logon would set them.
$userProfile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $ownerSid }).LocalPath
if (-not $userProfile) { $userProfile = "C:\Users\$name" }
$own = @(
  "set USERPROFILE=$userProfile", "set HOME=$userProfile", "set USERNAME=$name",
  "set APPDATA=$userProfile\AppData\Roaming", "set LOCALAPPDATA=$userProfile\AppData\Local",
  "set TEMP=$userProfile\AppData\Local\Temp", "set TMP=$userProfile\AppData\Local\Temp",
  "set HOMEDRIVE=C:", "set HOMEPATH=$($userProfile.Substring(2))"
)
Invoke-AsUserHere "e2e-interactive" ($own + $e2e) 2400
$here = Get-Content (Join-Path $ci "e2e-interactive.log") -Raw
# 2. As a password startup task runs it ("whether the user is logged on or not"): Session 0. Measured and reported, a
#    known gap (spec §14.1 item 2: the Session 0 launch); it fails the job only if it fails some other way.
$code = Invoke-AsUser "e2e" $e2e 2400
$text = Get-Content (Join-Path $ci "e2e.log") -Raw
# The uninstaller's order: the user forgets its own grants, then the administrator removes the rest.
$null = Invoke-AsUser "forget" @("`"$ucore`" sandbox forget", "echo exit=%ERRORLEVEL%", "`"$prot\srt-win.exe`" user status") 300
$forgot = Get-Content (Join-Path $ci "forget.log") -Raw
$removeCode = Invoke-Limited "remove for $name, by the administrator" $ucore @("sandbox", "remove") 900
$left = @()
if ($forgot -notmatch "exit=0") { $left += "the user's forget failed" }
if ($forgot -notmatch '"persistent_grants":\{[^}]*"state":"none"') { $left += "the user's persistent grants" }
if ($forgot -notmatch '"profile_grant":\{"state":"none"') { $left += "the user's profile read grant" }
if (Get-LocalUser | Where-Object Name -like "moss-sb-*") { $left += "pool accounts" }
if (Get-ChildItem -Directory C:\Users -Filter "moss-sb-*" -ErrorAction SilentlyContinue) { $left += "pool profile folders" }
if (Get-ScheduledTask -TaskName "MOSS Sandbox Reset $ownerSid" -ErrorAction SilentlyContinue) { $left += "the reset task" }
if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\markers\$ownerSid.json")) { $left += "the marker" }
if ($left.Count -gt 0) { Write-Output "left after forget and remove: $($left -join '; ')" }
# Neither launch can be proven green on a runner, and each must fail CLOSED: no command may run at all (a command that
# ran would print "-> ok"; one refused by the fence it ran under would print the fence's own error, not srt-win's).
#  - In its own session: the runner has one interactive session, the administrator's; srt-win's broker must own the
#    session's BaseNamedObjects (0xC0000022 in another user's), so a standard user's own logon is an owner live check.
#  - In Session 0 (a password startup task): \Sessions\0\BaseNamedObjects isn't there (0xC0000034), spec 14.1 item 2.
function Assert-FailedClosed([string]$Text, [string]$Where, [string]$Known) {
  if ($Text -match "exit=0") { Write-Output "the fenced suite passed as the standard user $Where"; return }
  $ran = [regex]::Matches($Text, "\[e2e\] (Bash|PowerShell) .* -> ok in") | Where-Object { $_ }
  if ($ran.Count -gt 0) { throw "as the standard user $Where, $($ran.Count) command(s) ran although the suite failed" }
  if ($Text -notmatch [regex]::Escape($Known)) { throw "the fenced suite failed as the standard user $Where for another reason than the known one ($Known)" }
  Write-Output "::warning::as the standard user ${Where}: every launch refused, none ran ($Known); a live check"
}
Assert-FailedClosed $here "in the administrator's interactive session" "BaseNamedObjects, READ_CONTROL|WRITE_DAC): NTSTATUS 0xC0000022"
if ($text -notmatch "session: 0") { throw "the user's task didn't run in Session 0" }
Assert-FailedClosed $text "in Session 0" "Sessions\0\BaseNamedObjects, READ_CONTROL|WRITE_DAC): NTSTATUS 0xC0000034"
if ($removeCode -ne 0) { throw "remove for the standard user exited $removeCode" }
if ($left.Count -gt 0) { throw "forget and remove left $($left.Count) thing(s)" }
Write-Output "a standard user: setup refused unelevated, set up by the administrator, every launch failed closed where the runner can't host it, forget and remove left nothing"
