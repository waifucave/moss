# `moss-core sandbox remove`, twice (the second finds nothing and exits 0), then what is left: every pool account, its
# profile folder and ProfileList key, its WFP filters, the marker, and the persistent grants. Fails on any leftover.
. "$PSScriptRoot/lib.ps1"
$pool = Get-Pool
# Long commands of pool accounts (lane WS5, the WS4 reviewer's item 1), started the way the daemon starts them and still
# running when remove begins: a foreground one, and (lane WS7) a bot's background command, each on its own account.
# Remove must end both (no process of a pool account outlives remove) and wait out neither; the background command's
# end comes back to its session as a failed or stopped task, with its log.
$holdOut = Join-Path $env:RUNNER_TEMP "moss-hold-result.json"
Remove-Item -LiteralPath $holdOut -Force -ErrorAction SilentlyContinue
$bunExe = (Get-Command bun).Source
$hold = Start-Process -FilePath $bunExe -ArgumentList @("scripts/ci/windows-fence/hold-account.ts", $holdOut) -WorkingDirectory $Root -NoNewWindow -PassThru
function PoolProcs { @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\moss-sb-*" }) }
$sw = [Diagnostics.Stopwatch]::StartNew()
function HeldAccounts { @(PoolProcs | ForEach-Object { ("$($_.UserName)" -split '\\')[-1] } | Sort-Object -Unique) }
while ((HeldAccounts).Count -lt 2 -and $sw.Elapsed.TotalSeconds -lt 300) { Start-Sleep -Milliseconds 500 }
$running = PoolProcs
$heldAccounts = HeldAccounts
Write-Output "pool accounts' commands are running: $($running.Count) process(es) after $([int]$sw.Elapsed.TotalSeconds) s ($($heldAccounts -join ', '))"
if ($heldAccounts.Count -lt 2) { throw "the two held commands never both started (accounts: $($heldAccounts -join ', '))" }
# The race remove must win (lane WS4): every account marked used and the reset task started (SYSTEM remakes each
# profile, ~20 s apiece), then remove at once, while the rebuild runs.
$poolState = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\pool\$Sid"
foreach ($m in $pool) {
  $gen = Join-Path $poolState "$($m.principal).gen"; $used = Join-Path $poolState "$($m.principal).used"
  if (Test-Path -LiteralPath $gen) { Set-Content -LiteralPath $used -Value ((Get-Content -Raw -LiteralPath $gen).Trim()) -NoNewline }
}
& schtasks.exe /run /tn "MOSS Sandbox Reset $Sid" | Out-Null
Start-Sleep -Seconds 3
Write-Output "the reset task is $((Get-ScheduledTask -TaskName "MOSS Sandbox Reset $Sid").State) when remove starts"
# Round 1 watched (lane WS5, the WS4 reviewer's item 3): the install marker must be gone before the first account is,
# so a running daemon (which reads it at every command) never leases an account remove has already deleted.
$first = $pool[0].principal
$rOut = [System.IO.Path]::GetTempFileName(); $rErr = [System.IO.Path]::GetTempFileName()
$rsw = [Diagnostics.Stopwatch]::StartNew()
$removeStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$rp = Start-Process -FilePath $Core -ArgumentList @("sandbox", "remove") -NoNewWindow -PassThru -RedirectStandardOutput $rOut -RedirectStandardError $rErr
$markerGone = $null; $accountGone = $null
while (-not $rp.HasExited -and $rsw.Elapsed.TotalSeconds -lt 900) {
  if ($null -eq $markerGone -and -not (Test-Path -LiteralPath $Marker)) { $markerGone = $rsw.Elapsed.TotalSeconds }
  if ($null -eq $accountGone -and -not (Get-LocalUser -Name $first -ErrorAction SilentlyContinue)) { $accountGone = $rsw.Elapsed.TotalSeconds }
  Start-Sleep -Milliseconds 200
}
if (-not $rp.HasExited) { & taskkill.exe /T /F /PID $rp.Id | Out-Null; throw "remove round 1 timed out" }
$rp.WaitForExit()
if ($null -eq $accountGone -and -not (Get-LocalUser -Name $first -ErrorAction SilentlyContinue)) { $accountGone = $rsw.Elapsed.TotalSeconds }
$removeSaid = @(Get-Content $rOut, $rErr | Where-Object { $_ -ne "" })
$removeSaid | Write-Output
Write-Output ("remove round 1: exit {0} in {1:N1} s; marker gone at {2} s, {3} gone at {4} s" -f $rp.ExitCode, $rsw.Elapsed.TotalSeconds, $markerGone, $first, $accountGone)
if ($rp.ExitCode -ne 0) {
  Write-Output "pool account processes now: $((PoolProcs | ForEach-Object { "$($_.ProcessName)#$($_.Id) $($_.UserName)" }) -join '; ')"
  Write-Output "the held command's caller: $(if ($hold.HasExited) { "exited $($hold.ExitCode)" } else { 'still running' }); result file: $(Test-Path -LiteralPath $holdOut)"
  throw "remove round 1 exited $($rp.ExitCode)"
}
if ($null -eq $markerGone -or $null -eq $accountGone -or $markerGone -gt $accountGone) { throw "the marker was not gone before the first account (marker $markerGone s, account $accountGone s)" }
# Remove ended each held command's processes itself (its own line names how many), before it deleted the account.
foreach ($heldAccount in $heldAccounts) {
  $endedCount = 0
  foreach ($l in $removeSaid) { if ("$l" -match "sandbox remove: $([regex]::Escape($heldAccount)): ended (\d+)") { $endedCount += [int]$Matches[1] } }
  if ($endedCount -lt 1) { throw "remove did not say it ended the held account's ($heldAccount) processes" }
}
$after = PoolProcs
if ($after.Count -gt 0) { throw "a pool account's process outlived remove: $(($after | ForEach-Object { "$($_.ProcessName)#$($_.Id) $($_.UserName)" }) -join '; ')" }
$hsw = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $holdOut) -and $hsw.Elapsed.TotalSeconds -lt 120) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path -LiteralPath $holdOut)) { throw "the held command's caller never heard back" }
$held = Get-Content -Raw -LiteralPath $holdOut | ConvertFrom-Json
$endedAfter = ($held.endedAt - $removeStartedAt) / 1000
Write-Output ("the held command ended: kind {0}, code {1}, {2:N1} s after remove started (its account was gone at {3:N1} s)" -f $held.kind, $held.code, $endedAfter, $accountGone)
if ("$($held.stdout)" -match "finished") { throw "the held command ran to its end" }
if ($endedAfter -gt ($accountGone + 30)) { throw "the held command ended only $endedAfter s after remove started, past its account's removal ($accountGone s)" }
$bg = $held.background
$bgAfter = ($bg.endedAt - $removeStartedAt) / 1000
Write-Output ("the held background command ended: told {0}, {1:N1} s after remove started; log: {2}" -f $bg.status, $bgAfter, (("$($bg.log)" -replace '\s+', ' ').Trim()))
if ($bg.isError) { throw "the background command was not started: $($bg.answer)" }
if (@("failed", "stopped") -notcontains $bg.status) { throw "the background command's end was told as $($bg.status), not failed or stopped" }
if ("$($bg.log)" -notmatch "started" -or "$($bg.log)" -match "finished") { throw "the background command's log does not show it started and was cut short" }
if ($bgAfter -gt ($accountGone + 30)) { throw "the background command ended only $bgAfter s after remove started, past its account's removal ($accountGone s)" }
$code = Invoke-Limited "remove (round 2)" $Core @("sandbox", "remove") 900
if ($code -ne 0) { throw "remove round 2 exited $code" }
if (-not $hold.HasExited) { & taskkill.exe /T /F /PID $hold.Id | Out-Null }
Remove-Item -LiteralPath (Join-Path $env:USERPROFILE ".moss-hold") -Recurse -Force -ErrorAction SilentlyContinue
# A rebuild still running after remove must not bring anything back: look again after it would have finished.
Start-Sleep -Seconds 60
# What the raced reset did (its own log): a member it found gone says "no such account, left".
$resetLog = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\reset-$Sid.log"
if (Test-Path -LiteralPath $resetLog) { Get-Content -LiteralPath $resetLog -Tail 4 | ForEach-Object { Write-Output "reset log: $_" } }
$left = @()
foreach ($m in $pool) {
  if (Get-LocalUser -Name $m.principal -ErrorAction SilentlyContinue) { $left += "account $($m.principal)" }
  if (Test-Path -LiteralPath (Join-Path "C:\Users" $m.principal)) { $left += "profile folder $($m.principal)" }
  $st = & $Srt status --sublayer-guid $m.sublayer | ConvertFrom-Json
  if ($st.wfp.filters -gt 0) { $left += "$($st.wfp.filters) WFP filters under $($m.sublayer)" }
}
$profiles = Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" | Where-Object { (Get-ItemProperty $_.PSPath).ProfileImagePath -like "*\moss-sb-*" }
foreach ($k in $profiles) { $left += "ProfileList $($k.PSChildName)" }
if (Test-Path -LiteralPath $Marker) { $left += "marker $Marker" }
if (Test-Path -LiteralPath $poolState) { $left += "pool state $poolState" }
$us = & $Srt user status | ConvertFrom-Json
if ($us.persistent_grants.state -ne "none") { $left += "persistent grants: $($us.persistent_grants | ConvertTo-Json -Compress)" }
if ($us.profile_grant.state -ne "none") { $left += "profile read grant: $($us.profile_grant | ConvertTo-Json -Compress)" }
if ($left.Count -gt 0) { Write-Output "left after remove:"; $left | ForEach-Object { Write-Output "  $_" }; throw "remove left $($left.Count) thing(s)" }
Write-Output "remove left nothing: no pool account, profile, ProfileList key, WFP filter, marker, pool state or persistent grant"
