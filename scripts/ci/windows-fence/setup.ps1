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
# The reset task (SYSTEM) once by hand, as the daemon starts it, and what it reported: every fresh principal is free.
& schtasks.exe /run /tn "MOSS Sandbox Reset $Sid" | Out-Null
Start-Sleep -Seconds 10
$info = Get-ScheduledTaskInfo -TaskName "MOSS Sandbox Reset $Sid"
Write-Output "reset task: last result $($info.LastTaskResult) at $($info.LastRunTime)"
$resetLog = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\reset-$Sid.log"
if (Test-Path -LiteralPath $resetLog) { Get-Content -LiteralPath $resetLog | ForEach-Object { Write-Output "reset log: $_" } }
$code = Invoke-Limited "reset, by hand (elevated)" $Core @("sandbox", "reset") 300
foreach ($m in Get-Pool) {
  $sidOf = (Get-LocalUser -Name $m.principal).SID.Value
  $k = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sidOf"
  Write-Output "$($m.principal): profile $(if (Test-Path $k) { 'present' } else { 'reset' })"
}
