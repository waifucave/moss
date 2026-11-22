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
# setup's own first logons leave each principal a profile: reset them once, elevated, before the user's first command.
$code = Invoke-Limited "reset for $name, by the administrator" $ucore @("sandbox", "reset") 300

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
Invoke-AsUserHere "e2e-interactive" $e2e 2400
$here = Get-Content (Join-Path $ci "e2e-interactive.log") -Raw
# 2. As a password startup task runs it ("whether the user is logged on or not"): Session 0. Measured and reported, a
#    known gap (spec §14.1 item 2: the Session 0 launch); it fails the job only if it fails some other way.
$null = & $ucore sandbox reset
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
if ($here -notmatch "exit=0") { throw "the fenced suite failed as the standard user in its own session" }
if ($text -notmatch "session: 0") { throw "the user's task didn't run in Session 0" }
if ($text -notmatch "exit=0") {
  if ($text -match "Sessions\\0\\BaseNamedObjects") { Write-Output "::warning::Session 0 (a password startup task): srt-win can't open \Sessions\0\BaseNamedObjects (0xC0000034), the known gap of spec 14.1 item 2; every command there is refused" }
  else { throw "the fenced suite failed in Session 0 for another reason than the known BaseNamedObjects gap" }
}
if ($removeCode -ne 0) { throw "remove for the standard user exited $removeCode" }
if ($left.Count -gt 0) { throw "forget and remove left $($left.Count) thing(s)" }
Write-Output "the fenced suite passed as a standard user in its own session; Session 0 measured above"
