#!/bin/sh
# Make the tvweb launcher the TV's Home target, or put the stock home back, and
# re-apply the choice after a reboot. Runs on the TV, from the tools already there.
#
# The Home key's target is hardcoded in the compositor's key handler
# (/usr/lib/qml/KeyFilters/systemUi.js), which sits on a read-only overlay - so
# the change is a bind-mount of a modified copy, and the compositor is restarted
# to read it. A flag file makes the boot hook re-apply it. Safe to re-run; a
# reboot without the flag leaves the stock home.
#
# webOS 9 only: older TVs (e.g. webOS 4) draw the home from the compositor, not a
# key handler at this path, so there `status` reports unsupported and the
# dashboard hides the switch.

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

KF=/usr/lib/qml/KeyFilters/systemUi.js
DIR=/var/lib/tvweb/home
STAGE="$DIR/systemUi.js"
FLAG="$DIR/enabled"
LAUNCHER=com.tvweb.launcher

# Supported only where our exact edit applies: the key handler exists and holds
# the launch call we rewrite (the stock home one, or our launcher one when already
# on). Older TVs draw the home from the compositor with no such handler here, so
# this is false and the dashboard hides the switch.
supported() {
  [ -f "$KF" ] && command -v luna-send >/dev/null 2>&1 &&
    grep -qE 'applicationManager\.launch\("com\.(webos\.app\.home|tvweb\.launcher)"' "$KF" 2>/dev/null
}
active() { grep -q "launch(\"$LAUNCHER\"" "$KF" 2>/dev/null; }

mount_reload() {   # bind the staged handler over the stock one and reload the compositor
  mount --bind "$STAGE" "$KF" 2>/dev/null || return 1
  systemctl restart --no-block surface-manager 2>/dev/null
}

stage() {   # build the modified handler from the current stock file, and validate it
  mkdir -p "$DIR"
  # $KF is the stock file here (the mount is not active), so this reads stock.
  sed 's/applicationManager\.launch("com\.webos\.app\.home"/applicationManager.launch("'"$LAUNCHER"'"/' \
    "$KF" > "$STAGE.tmp" 2>/dev/null || return 1
  # Never keep an edit that would not parse: a broken key handler takes the whole
  # compositor down. Checked here, at enable time, when the system is settled.
  node --check "$STAGE.tmp" 2>/dev/null || { rm -f "$STAGE.tmp"; return 1; }
  grep -q "launch(\"$LAUNCHER\"" "$STAGE.tmp" || { rm -f "$STAGE.tmp"; return 1; }
  mv -f "$STAGE.tmp" "$STAGE"
}

apply() {   # enable: build a fresh validated handler, then mount and reload
  active && return 0
  stage || return 1
  mount_reload
}

reapply() { # boot: re-mount the handler already validated at enable time. Runs no
            # node - spawning it under boot-time load is flaky and needless here.
  active && return 0
  { [ -f "$STAGE" ] && grep -q "launch(\"$LAUNCHER\"" "$STAGE"; } || return 1
  mount_reload
}

revert() {
  active || return 0
  umount "$KF" 2>/dev/null
  systemctl restart --no-block surface-manager 2>/dev/null
}

case "$1" in
  enable)
    supported || { echo '{"ok":false,"error":"not supported on this TV"}'; exit 0; }
    mkdir -p "$DIR"; : > "$FLAG"
    if apply; then echo '{"ok":true,"enabled":true,"active":true}'
    else echo '{"ok":false,"error":"could not switch the Home key"}'; fi
    ;;
  disable)
    rm -f "$FLAG"
    revert
    echo '{"ok":true,"enabled":false,"active":false}'
    ;;
  boot)
    [ -f "$FLAG" ] && reapply
    ;;
  status)
    s=false; supported && s=true
    en=false; [ -f "$FLAG" ] && en=true
    ac=false; active && ac=true
    echo "{\"ok\":true,\"supported\":$s,\"enabled\":$en,\"active\":$ac}"
    ;;
  *)
    echo '{"ok":false,"error":"usage: home-mode.sh enable|disable|boot|status"}'
    exit 1
    ;;
esac
