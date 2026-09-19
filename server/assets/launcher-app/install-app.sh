#!/bin/sh
# Package the tvweb launcher as a webOS app and install it, so it appears on the
# home screen and launches from its own tile. Runs on the TV, from the tools
# already there, and is safe to re-run: it reinstalls in place.
#
# The launcher UI, its data, fonts and icons are all served by the tvweb server
# on this TV; this app is a thin wrapper that opens that page. Kept as an app of
# its own so the home screen (and, later, the Home key) can reach it without
# touching LG's home app.
#
# Only the developer install service takes an unsigned app; the retail one
# rejects it. That service answers on webOS 9. Where it is absent or the install
# does not complete - as on older webOS - this exits without failing, and the
# served launcher page stays the way in.

ID=com.tvweb.launcher
VER=1.0.0
SRC=${1:-/var/lib/tvweb/assets/launcher-app}

[ -f "$SRC/appinfo.json" ] || { echo "launcher app files not found in $SRC"; exit 0; }
command -v luna-send >/dev/null 2>&1 || { echo "no luna-send; skipping the home-screen app"; exit 0; }

WORK=$(mktemp -d /tmp/tvweb-app.XXXXXX) || exit 0
trap 'rm -rf "$WORK"' EXIT

# The installer wants the app under usr/palm/applications and a matching package
# manifest under usr/palm/packages; without the package manifest it fails.
APP="$WORK/data/usr/palm/applications/$ID"
PKG="$WORK/data/usr/palm/packages/$ID"
mkdir -p "$APP/assets" "$PKG"
cp "$SRC/appinfo.json" "$SRC/index.html" "$APP/" || exit 0
cp "$SRC/assets/icon80.png" "$SRC/assets/icon130.png" "$APP/assets/" 2>/dev/null
cp "$SRC/packageinfo.json" "$PKG/" || exit 0

printf '2.0\n' > "$WORK/debian-binary"
cat > "$WORK/control" <<CTRL
Package: $ID
Version: $VER
Architecture: all
Maintainer: tvweb
Description: tvweb launcher
CTRL

# tar then gzip separately: the BusyBox tar on webOS 9 is built without gzip, so
# `tar -z` is unavailable there.
( cd "$WORK" && tar -cf control.tar ./control && gzip -nf control.tar )
( cd "$WORK/data" && tar -cf ../data.tar ./usr && gzip -nf ../data.tar )

# Assemble the ar archive by hand: BusyBox `ar` extracts but cannot create, and
# the ipk format is just an ar of three members with 60-byte headers.
IPK="$WORK/${ID}_${VER}_all.ipk"
printf '!<arch>\n' > "$IPK"
ar_add() {
  f="$WORK/$1"; sz=$(wc -c < "$f")
  printf '%-16s%-12d%-6d%-6d%-8s%-10d`\n' "$1" 0 0 0 100644 "$sz" >> "$IPK"
  cat "$f" >> "$IPK"
  [ $((sz % 2)) -eq 1 ] && printf '\n' >> "$IPK"   # members are padded to even
  return 0
}
ar_add debian-binary
ar_add control.tar.gz
ar_add data.tar.gz

LOG="$WORK/install.log"
luna-send -i -w 60000 luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"$ID\",\"ipkUrl\":\"$IPK\",\"subscribe\":true}" > "$LOG" 2>&1 &
lpid=$!
n=0
while [ "$n" -lt 25 ]; do
  grep -q '"state":"installed"' "$LOG" 2>/dev/null && break
  grep -q 'errorText\|install failed' "$LOG" 2>/dev/null && break
  sleep 1; n=$((n + 1))
done
kill "$lpid" 2>/dev/null

if grep -q '"state":"installed"' "$LOG" 2>/dev/null; then
  echo "launcher added to the home screen"
else
  echo "launcher app not installed (the served launcher page still works)"
fi
