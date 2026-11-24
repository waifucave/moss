# Shared by the windows-fence scripts: the protected copy (where lane M's installer puts moss-core.exe and srt-win.exe,
# `%ProgramFiles%\MOSS Sandbox\<user SID>\`), the owner's pool, and a step with a time limit.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Protected = Join-Path ([Environment]::GetFolderPath("ProgramFiles")) "MOSS Sandbox\$Sid"
$Core = Join-Path $Protected "moss-core.exe"
$Srt = Join-Path $Protected "srt-win.exe"
$Marker = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "MOSS Sandbox\markers\$Sid.json"

# The owner's pool (names and per-slot WFP sublayers), from core itself.
function Get-Pool {
  $js = "import{installedPool}from'./packages/core/src/fence/win-sandbox.ts';console.log(JSON.stringify(installedPool(process.argv[1])))"
  Push-Location $Root
  try { return (& bun -e $js $Sid | ConvertFrom-Json) } finally { Pop-Location }
}

# Runs `exe args` with a time limit; prints its output and exit code. On a timeout, names the processes it left running
# (names and pids only) and ends them, then throws.
function Invoke-Limited([string]$Name, [string]$Exe, [string[]]$ArgList, [int]$Seconds = 300) {
  Write-Host "== $Name"
  $out = [System.IO.Path]::GetTempFileName(); $err = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit($Seconds * 1000)) {
    $kids = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }
    Write-Host "-- TIMEOUT after $Seconds s; children: $($kids -join ', ')"
    Get-Content $out, $err | Write-Host
    & taskkill.exe /T /F /PID $p.Id | Out-Null
    throw "$Name timed out"
  }
  $p.WaitForExit()
  Get-Content $out, $err | Where-Object { $_ -ne "" } | Write-Host
  Write-Host "-- exit: $($p.ExitCode)"
  return $p.ExitCode
}
