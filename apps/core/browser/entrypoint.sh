#!/bin/sh
# Starts the screen and the browser of the agent (D-264). Nothing listens on
# TCP, not even on the loopback of the container (which has no network
# anyway): VNC and CDP are two Unix sockets in /tmp, and the core reaches
# them only through `docker exec ... socat STDIO UNIX-CONNECT:<socket>`.
set -eu

WIDTH=1280
HEIGHT=800

if [ "${1:-}" = chromium ]; then
  # Run by socat at the first connection to /tmp/cdp.sock: CDP comes in on
  # fd 3 and goes out on fd 4 (--remote-debugging-pipe, messages ended by
  # NUL), so Chromium opens no debugging port.
  export DISPLAY=:1
  # "MAP * ~NOTFOUND": no name resolves inside the browser (the container has
  # no network; from step 2 every request is fulfilled by the core).
  exec chromium \
    --remote-debugging-pipe \
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
fi

# /tmp is a tmpfs: Xvnc (not root) cannot create its socket folder, Chromium
# wants a folder for crash reports even with breakpad off.
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p /srv/browser/crash

# The X server with its own VNC server on a Unix socket only (-rfbport -1:
# no TCP port); no password, because the only way in is Docker. No X over
# TCP, no clipboard.
Xvnc :1 \
  -geometry "${WIDTH}x${HEIGHT}" -depth 24 \
  -rfbport -1 -rfbunixpath /tmp/vnc.sock -rfbunixmode 0600 \
  -SecurityTypes None \
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

# One CDP session per container: socat accepts one connection, starts
# Chromium on it and exits with it, and the container ends.
exec socat UNIX-LISTEN:/tmp/cdp.sock,mode=0600,unlink-early \
  EXEC:"/usr/local/bin/arianna-browser chromium",fdin=3,fdout=4
