# Where a windows-fence job runs: the logon session, the account and whether it is elevated, Secondary Logon, and the
# shells the fenced Bash and PowerShell use. Nothing here reads another process's environment or a secret.
$ErrorActionPreference = "Continue"
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([System.Security.Principal.WindowsPrincipal]$me).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "os: $([System.Environment]::OSVersion.VersionString) ($((Get-CimInstance Win32_OperatingSystem).Caption))"
Write-Output "session: $((Get-Process -Id $PID).SessionId)"
Write-Output "user: $($me.Name) sid: $($me.User.Value) elevated-admin: $admin"
$seclogon = Get-Service seclogon -ErrorAction SilentlyContinue
Write-Output "seclogon: $(if ($seclogon) { "$($seclogon.Status) / $($seclogon.StartType)" } else { 'absent' })"
foreach ($p in @("$env:ProgramFiles\Git\bin\bash.exe", "$env:ProgramFiles\Git\usr\bin\bash.exe", "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe", "$env:ProgramFiles\PowerShell\7\pwsh.exe")) {
  Write-Output "shell: $p present=$(Test-Path -LiteralPath $p)"
}
Write-Output "rustup: $((Get-Command rustup -ErrorAction SilentlyContinue).Source)"
Write-Output "cargo: $((Get-Command cargo -ErrorAction SilentlyContinue).Source)"
