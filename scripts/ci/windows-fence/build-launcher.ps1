# Build srt-win from the pinned source with MOSS's patches (scripts/build-srt-win.ps1), then compare the result's
# Authenticode digest with the pin the launch checks (SRT_WIN_PINS in packages/core/src/fence/windows-launcher.ts).
# A mismatch fails the job: every launch would refuse it (exit 3), and no override exists to make it run.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
Set-Location $root
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-srt-win.ps1
if ($LASTEXITCODE -ne 0) { throw "build-srt-win failed (exit $LASTEXITCODE)" }
$exe = Join-Path $root "vendor/srt-win/srt-win.exe"
# The pin of this machine's architecture: the build has no -Target, so it is the host's (arm64 on windows-11-arm).
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$measure = "import{authenticodeDigest,SRT_WIN_PINS}from'./packages/core/src/fence/windows-launcher.ts';import{readFileSync}from'node:fs';const a=process.argv[2];const d=authenticodeDigest(readFileSync(process.argv[1]));console.log(JSON.stringify({arch:a,digest:d,pin:SRT_WIN_PINS[a],match:d===SRT_WIN_PINS[a]}))"
$out = & bun -e $measure $exe $arch
Write-Output "launcher: $out"
$o = $out | ConvertFrom-Json
if (-not $o.match) { throw "the built launcher's digest $($o.digest) is not the pinned $($o.pin)" }
