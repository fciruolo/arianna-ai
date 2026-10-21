#!/bin/sh
# Starts the screen and the browser of the agent (D-264). Nothing listens
# outside the loopback of the container, which has no network anyway: the
# core reaches 5900 (VNC) and 9222 (CDP) only through `docker exec ... socat`.
set -eu

WIDTH=1280
HEIGHT=800

# /tmp is a tmpfs: Xvnc (not root) cannot create its socket folder, Chromium
# wants a folder for crash reports even with breakpad off.
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p /srv/browser/crash

# The X server with its own VNC server, on 127.0.0.1:5900 only; no password,
# because the only way in is Docker. No X over TCP, no clipboard.
Xvnc :1 \
  -geometry "${WIDTH}x${HEIGHT}" -depth 24 \
  -rfbport 5900 -localhost -SecurityTypes None \
  -nolisten tcp -AlwaysShared -AcceptSetDesktopSize=0 \
  -SendCutText=0 -AcceptCutText=0 &

i=0
while [ ! -S /tmp/.X11-unix/X1 ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvnc did not start" >&2
    exit 1
  fi
  sleep 0.1
done

export DISPLAY=:1
# "MAP * ~NOTFOUND": no name resolves inside the browser (the container has
# no network; from step 2 every request is fulfilled by the core).
exec chromium \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/srv/browser/profile \
  '--host-resolver-rules=MAP * ~NOTFOUND' \
  --dns-prefetch-disable \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-extensions \
  --disable-background-networking \
  --disable-component-update \
  --disable-breakpad \
  --password-store=basic \
  --window-position=0,0 \
  "--window-size=${WIDTH},${HEIGHT}" \
  --start-fullscreen \
  about:blank
