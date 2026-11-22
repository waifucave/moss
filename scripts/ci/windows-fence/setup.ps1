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

# The same reset as SYSTEM with its output kept (the reset task's own run shows only a result code): what it says,
# and if it is still running after two minutes, which processes it is waiting on (names and pids only).
$ciDir = "C:\moss-ci"; New-Item -ItemType Directory -Force -Path $ciDir | Out-Null
$sysLog = Join-Path $ciDir "reset-system.log"
$act = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /s /c `"`"$Core`" sandbox reset > $sysLog 2>&1`""
$pr = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "moss-ci-reset-system" -Action $act -Principal $pr -Force | Out-Null
Start-ScheduledTask -TaskName "moss-ci-reset-system"
$deadline = (Get-Date).AddSeconds(120)
do { Start-Sleep -Seconds 3; $st = (Get-ScheduledTask -TaskName "moss-ci-reset-system").State } while ($st -eq "Running" -and (Get-Date) -lt $deadline)
Write-Output "reset as SYSTEM: state $st, result $((Get-ScheduledTaskInfo -TaskName "moss-ci-reset-system").LastTaskResult)"
if (Test-Path $sysLog) { Get-Content $sysLog | ForEach-Object { Write-Output "reset as SYSTEM: $_" } }
if ($st -eq "Running") {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("moss-core.exe", "powershell.exe", "reg.exe", "net.exe", "cmd.exe", "icacls.exe") } | ForEach-Object { Write-Output "running: $($_.Name)#$($_.ProcessId) parent $($_.ParentProcessId)" }
  Stop-ScheduledTask -TaskName "moss-ci-reset-system"
}
Unregister-ScheduledTask -TaskName "moss-ci-reset-system" -Confirm:$false
