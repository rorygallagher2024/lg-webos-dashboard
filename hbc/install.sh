#!/bin/sh
# Put the server this app carries in place, or bring it up to date, and make
# sure it is running. Run as root by the app's own launch page, through the
# Homebrew Channel's exec service, whenever the server does not answer with the
# version the app was built with. Safe to run any number of times.
#
# Does what deploy.sh does on the TV, from files that arrived inside the app
# rather than over SSH. Installs made either way share /var/lib/tvweb, so one
# made with deploy.sh is upgraded in place, config and all.
#
# Prints one JSON line last, which the launch page reads.

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/server"
D=/var/lib/tvweb
HOOKDIR=/var/lib/webosbrew/init.d

version_of() { sed -n "s/^var TVWEB_VERSION = '\([^']*\)';.*/\1/p" "$1" 2>/dev/null; }
# Whether dotted version $1 is newer than $2. BusyBox sort has no -V.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 1 }'
}
running() { [ -x "$D/tvwebctl" ] && "$D/tvwebctl" status 2>/dev/null | grep -q '^running'; }
web_off() {
  [ -f "$D/config.json" ] && tr -d ' \t\r\n' < "$D/config.json" | grep -q '"web":{[^}]*"enabled":false'
}
result() {   # action; also whether the dashboard is off, and the old tile's fate
  off=false; web_off && off=true
  printf '{"ok":true,"action":"%s","version":"%s","webOff":%s,"oldTile":%s}\n' \
    "$1" "$(version_of "$D/tvweb.js")" "$off" "${OLD_TILE:-null}"
}

# This app is the tile from now on: say so, which also stops the server's own
# installer offering or refreshing the one deploy.sh added, then retire that
# one if it is not open. Its answer is passed back for the launch page.
adopt() {
  # Records where the app lives, so the server can tell when it is uninstalled.
  dirname "$HERE" > "$D/.from-homebrew-channel"
  OLD_TILE=$(sh "$D/assets/dashboard-app/install-app.sh" retire 2>/dev/null | tail -1)
  case "$OLD_TILE" in "{"*) ;; *) OLD_TILE=null ;; esac
}
# A link into this app rather than a copy, as the Homebrew Channel asks: once
# the app is removed the link leads nowhere and nothing runs at boot. Replaces
# the copy an earlier build or deploy.sh left there.
link_hook() {
  # The same for the app itself, whose page has the Homebrew Channel run this
  # as root, and whose hook runs at boot.
  chmod -R go-w "$(dirname "$HERE")" 2>/dev/null
  chmod +x "$SRC/50-tvweb.sh" 2>/dev/null
  mkdir -p "$HOOKDIR" && ln -sf "$SRC/50-tvweb.sh" "$HOOKDIR/50-tvweb"
}
fail() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit 0; }

[ -f "$SRC/tvweb.js" ] || fail "the app has no server files in it"
want=$(version_of "$SRC/tvweb.js")
have=$(version_of "$D/tvweb.js")

# Already this version, or newer - never downgrade: only make sure it is up. At
# a cold boot the launch page can get here before the boot hook has started it.
if [ -n "$have" ] && { [ "$have" = "$want" ] || newer "$have" "$want"; }; then
  running || "$D/tvwebctl" start >/dev/null 2>&1
  link_hook
  adopt
  result started
  exit 0
fi

# Copied beside the install and renamed into place, never written over: BusyBox's
# shell reads a script as it runs it, so overwriting tvwebctl would corrupt the
# watchdog running out of it.
mkdir -p "$D" || fail "could not create $D"
S="$D/.hbc-stage"
rm -rf "$S"
cp -r "$SRC" "$S" || fail "could not copy the server files"
( cd "$S" && find . -type f ) | while read -r f; do
  case "$f" in ./50-tvweb.sh) continue ;; esac
  mkdir -p "$D/$(dirname "$f")"
  mv -f "$S/$f" "$D/$f"
done
chmod +x "$D/tvwebctl" 2>/dev/null
# ares-package stores plain files as 0666. The server runs as root, so nothing
# else on the TV may be able to change its code.
chmod -R go-w "$D" 2>/dev/null

# A first install starts closed - answering only on the TV itself - and asks
# the owner through the setup screens whether to open it to the network. One
# that already has a config, from deploy.sh or before, keeps it as it is.
if [ -z "$have" ] && [ ! -f "$D/config.json" ]; then
  printf '{\n  "host": "127.0.0.1"\n}\n' > "$D/config.json"
  : > "$D/.setup-pending"
fi
chmod 600 "$D/config.json" 2>/dev/null

rm -rf "$S"

[ "$(version_of "$D/tvweb.js")" = "$want" ] || fail "the new files did not take"
link_hook
# Before the restart, so the server starting up finds nothing left to retire.
adopt
"$D/tvwebctl" restart >/dev/null 2>&1
if [ -n "$have" ]; then result upgraded; else result installed; fi
