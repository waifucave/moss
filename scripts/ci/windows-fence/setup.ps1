# `moss-core sandbox setup` from the protected copy, as lane M's installer runs it: the status before (not set up), setup
# twice (idempotent: the second run changes nothing and exits 0), and the status after (every pool member ready).
. "$PSScriptRoot/lib.ps1"
New-Item -ItemType Directory -Force -Path $Protected | Out-Null
Copy-Item -Force (Join-Path $Root "dist/daemon/windows-x64/moss-core.exe") $Core
Copy-Item -Force (Join-Path $Root "vendor/srt-win/srt-win.exe") $Srt
$code = Invoke-Limited "status before setup" $Core @("sandbox", "status", "--json") 120
if ($code -eq 0) { throw "status says ready before setup" }
foreach ($round in 1, 2) {
  $code = Invoke-Limited "setup (round $round)" $Core @("sandbox", "setup") 900
  if ($code -ne 0) { throw "setup round $round exited $code" }
}
$code = Invoke-Limited "status after setup" $Core @("sandbox", "status", "--json") 120
if ($code -ne 0) { throw "status after setup exited $code" }
Write-Output "marker: $(Get-Content -Raw $Marker)"
$poolState = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\pool\$Sid"
Get-ChildItem -LiteralPath $poolState | ForEach-Object { Write-Output "pool state: $($_.Name) [$((Get-Content -Raw -LiteralPath $_.FullName) -replace '\s','')]" }
& icacls.exe $poolState | ForEach-Object { Write-Output "pool acl: $_" }
# Every principal starts remade and unused: its profile there (the warm-up's), a generation, an empty used record.
foreach ($m in Get-Pool) {
  $sidOf = (Get-LocalUser -Name $m.principal).SID.Value
  $k = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sidOf"
  if (-not (Test-Path $k)) { throw "$($m.principal) has no profile after setup" }
  $gen = (Get-Content -Raw -LiteralPath (Join-Path $poolState "$($m.principal).gen")).Trim()
  if ($gen -notmatch '^[0-9a-f]{32}$') { throw "$($m.principal) has no generation after setup" }
}

# The reset task (SYSTEM), as the daemon starts it after a command, on a principal marked used: its profile is
# remade (deleted, made again by CreateProfile) and it gets a new generation; the others are left as they are.
$m1 = (Get-Pool)[0].principal
$genFile = Join-Path $poolState "$m1.gen"; $usedFile = Join-Path $poolState "$m1.used"
$before = (Get-Content -Raw -LiteralPath $genFile).Trim()
Set-Content -LiteralPath $usedFile -Value $before -NoNewline
$sw = [Diagnostics.Stopwatch]::StartNew()
& schtasks.exe /run /tn "MOSS Sandbox Reset $Sid" | Out-Null
do { Start-Sleep -Milliseconds 500; $st = (Get-ScheduledTask -TaskName "MOSS Sandbox Reset $Sid").State } while ($st -eq "Running" -or ((Get-Content -Raw -LiteralPath $genFile).Trim() -eq $before -and $sw.Elapsed.TotalSeconds -lt 120))
$sw.Stop()
$info = Get-ScheduledTaskInfo -TaskName "MOSS Sandbox Reset $Sid"
$after = (Get-Content -Raw -LiteralPath $genFile).Trim()
Write-Output ("timing: the reset task remakes one used principal (SYSTEM) {0} ms; result {1}" -f $sw.ElapsedMilliseconds, $info.LastTaskResult)
$resetLog = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\reset-$Sid.log"
if (Test-Path -LiteralPath $resetLog) { Get-Content -LiteralPath $resetLog | ForEach-Object { Write-Output "reset log: $_" } }
if ($info.LastTaskResult -ne 0) { throw "the reset task exited $($info.LastTaskResult)" }
if ($after -eq $before) { throw "the reset task didn't remake $m1 (its generation is unchanged)" }
$sid1 = (Get-LocalUser -Name $m1).SID.Value
if (-not (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid1")) { throw "$m1 has no profile after the reset" }
Write-Output "the reset task remade $m1 as SYSTEM and left the others"
