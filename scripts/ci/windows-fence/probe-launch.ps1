# The probe: moss-core.exe and srt-win.exe in the protected copy, `sandbox setup` twice, three shells launched as pool
# principal 1, then `sandbox remove` and what it left. Prints results; fails only on a broken step it cannot report.
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$dir = Join-Path ([Environment]::GetFolderPath("ProgramFiles")) "MOSS Sandbox\$sid"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -Force (Join-Path $root "dist/daemon/windows-x64/moss-core.exe") (Join-Path $dir "moss-core.exe")
Copy-Item -Force (Join-Path $root "vendor/srt-win/srt-win.exe") (Join-Path $dir "srt-win.exe")
$core = Join-Path $dir "moss-core.exe"
$srt = Join-Path $dir "srt-win.exe"
function Step($name, [scriptblock]$b) {
  Write-Output "== $name"
  $o = & $b 2>&1 | Out-String
  Write-Output $o.TrimEnd()
  Write-Output "-- exit: $LASTEXITCODE"
}
Step "status before setup" { & $core sandbox status --json }
Step "setup" { & $core sandbox setup }
Step "setup again (idempotent)" { & $core sandbox setup }
Step "status after setup" { & $core sandbox status --json }
$h = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sid))).Replace("-", "").ToLower().Substring(0, 6)
$p = "moss-sb-$h-1"
Write-Output "principal: $p"
Step "user status" { & $srt user status --user $p }
Step "exec cmd" { & $srt exec --quiet --user $p --write-restricted-token -- "$env:SystemRoot\System32\cmd.exe" /d /c "echo cmd-ok & whoami" }
Step "exec git bash" { & $srt exec --quiet --user $p --write-restricted-token -- "$env:ProgramFiles\Git\bin\bash.exe" -c "echo bash-ok; whoami; echo HOME=`$HOME" }
Step "exec git bash (usr/bin)" { & $srt exec --quiet --user $p --write-restricted-token -- "$env:ProgramFiles\Git\usr\bin\bash.exe" -c "echo bash-ok; whoami" }
Step "exec powershell" { & $srt exec --quiet --user $p --write-restricted-token -- "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Write-Output ps-ok; whoami" }
Step "exec write to the runner's temp (refused?)" { & $srt exec --quiet --user $p --write-restricted-token -- "$env:SystemRoot\System32\cmd.exe" /d /c "echo x> `"$env:RUNNER_TEMP\fence-probe.txt`" && echo wrote" }
Write-Output "runner temp file exists: $(Test-Path (Join-Path $env:RUNNER_TEMP 'fence-probe.txt'))"
Step "remove" { & $core sandbox remove }
Step "remove again (nothing left)" { & $core sandbox remove }
Write-Output "== leftovers"
Write-Output "accounts: $((Get-LocalUser | Where-Object Name -like 'moss-sb-*' | ForEach-Object Name) -join ', ')"
Write-Output "profiles: $((Get-ChildItem -Directory C:\Users -Filter 'moss-sb-*' -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')"
$marker = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\markers\$sid.json"
Write-Output "marker: $(Test-Path -LiteralPath $marker)"
