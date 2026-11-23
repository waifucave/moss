# `moss-core sandbox remove`, twice (the second finds nothing and exits 0), then what is left: every pool account, its
# profile folder and ProfileList key, its WFP filters, the marker, and the persistent grants. Fails on any leftover.
. "$PSScriptRoot/lib.ps1"
$pool = Get-Pool
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
foreach ($round in 1, 2) {
  $code = Invoke-Limited "remove (round $round)" $Core @("sandbox", "remove") 900
  if ($code -ne 0) { throw "remove round $round exited $code" }
}
# A rebuild still running after remove must not bring anything back: look again after it would have finished.
Start-Sleep -Seconds 60
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
