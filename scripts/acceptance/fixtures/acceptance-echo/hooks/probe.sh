#!/bin/sh
# The acceptance run's command hook (turn.start): notes the event it was given, then tries what its plugin's fence
# must refuse, and writes what it saw to its own data folder for the run to read. The run checks the disk and its
# own listener itself; this file is only the hook's side of it. The targets come from hooks/targets, which the run
# writes before the install: the port of a listener on 127.0.0.1, and a path outside the hook's allowed folders.
input=$(cat)
event=$(printf '%s' "$input" | tr ',' '\n' | sed -n 's/^.*"event":"\([^"]*\)".*$/\1/p' | head -n 1)
port=$(sed -n 1p hooks/targets 2>/dev/null)
outside=$(sed -n 2p hooks/targets 2>/dev/null)
# Line 3 `unfenced` (the run writes it where no fence holds the plugin: Linux, plugin code runs as the user): the two writes would succeed and
# change the tree the person's OK covers, so they are not tried.
mode=$(sed -n 3p hooks/targets 2>/dev/null)
out="$MOSS_PLUGIN_DATA/hook-probe.txt"
{
  echo "event=$event"
  if [ "$mode" = unfenced ]; then echo outside=skipped; echo tree=skipped; else
    (echo escaped > "$outside") 2>/dev/null && echo outside=written || echo outside=denied
    (echo escaped > "$MOSS_PLUGIN_ROOT/escaped") 2>/dev/null && echo tree=written || echo tree=denied
  fi
  /usr/bin/nc -z -w 2 127.0.0.1 "$port" >/dev/null 2>&1 && echo direct=reached || echo direct=denied
  # Through its proxy (the env lane B's fence gives it): 127.0.0.1 is no host the plugin declared, so the proxy refuses.
  code=$(/usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)
  echo "proxied=${code:-none}"
} > "$out.part" 2>/dev/null && mv "$out.part" "$out"
exit 0
