#!/bin/sh
# Point a streaming shortcut button on the remote (Netflix, Prime, Disney+ and
# the rest) at a different app. Runs on the TV, from the tools already there.
#
# The TV's own button-to-app table, mapping_info in the settings service, is not
# usable for this: appLaunch.js takes LG's cloud response as authoritative and
# writes it back over any local change, so a remap there is reverted at the next
# sync. Measured on a C2: a written remap read back correctly, then returned to
# the stock app id after a compositor restart.
#
# So the key is caught earlier instead. The compositor runs its key filters in
# order and systemUi.js comes before appLaunch.js, so a case added there that
# returns KeyPolicy.Accepted launches our app and the CP-hotkey handler never
# sees the press. systemUi.js is on a read-only overlay, hence a bind-mount of a
# patched copy, and the compositor is restarted to read it.
#
# A bind-mount does not survive a reboot, so a power cycle always restores the
# stock file - which is the recovery path if a patch ever misbehaves. The boot
# hook re-applies the choice.

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# The key filters moved between releases: webOS 9 keeps them under /usr/lib/qml,
# webOS 4 under /usr/lib/qt5/qml. Both are checked so one script covers both.
KFDIR=""
for d in /usr/lib/qml/KeyFilters /usr/lib/qt5/qml/KeyFilters; do
  [ -f "$d/systemUi.js" ] && { KFDIR="$d"; break; }
done
KF="$KFDIR/systemUi.js"
APPLAUNCH="$KFDIR/appLaunch.js"
DIR=/var/lib/tvweb/shortcut
HERE=$(dirname "$0")                        # the helper ships beside this script
BUTTONS_JS="$HERE/shortcut-buttons.js"
STOCK="$DIR/systemUi.stock.js"
STAGED="$DIR/systemUi.staged.js"
# Both working names end .js: node --check refuses a file whose extension it
# does not know, so a .tmp here would fail the validation every time.
WORK="$DIR/systemUi.work.js"
CHECK="$DIR/systemUi.check.js"
BINDINGS="$DIR/bindings"
DEFAULT_APP=com.tvweb.dashboard

# The cases go at the very top of the switch in handleSystemKeys, immediately
# after the switch statement itself.
#
# Not above a particular stock case: on webOS 4 several of them are a
# fall-through group - Qt.Key_Super_L and Qt.Key_Menu fall into
# WebOS.Key_webOS_Recent - and slipping a case into the middle of one would
# quietly capture the Home and Menu keys as well. The top of the switch belongs
# to no group, and a case there ends in a return, so nothing falls into ours.
MARKER='// tvweb-shortcut'

json_err() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit 0; }

mounted() { grep -q "$MARKER" "$KF" 2>/dev/null; }

supported() {
  [ -n "$KFDIR" ] && [ -f "$KF" ] && [ -f "$APPLAUNCH" ] && [ -f "$BUTTONS_JS" ] &&
    command -v node >/dev/null 2>&1 &&
    command -v luna-send >/dev/null 2>&1 &&
    grep -q 'function handleSystemKeys' "$KF" 2>/dev/null &&
    grep -q 'switch (key)' "$KF" 2>/dev/null
}

# A pristine copy to patch from. Only ever taken from an unmounted $KF, so a
# patched file can never become the base for the next patch - which would stack
# a second copy of the cases on every change.
save_stock() {
  grep -q "$MARKER" "$KF" 2>/dev/null && return 1
  cp -f "$KF" "$STOCK"
}

unmount_kf() {
  mounted || return 0
  umount "$KF" 2>/dev/null || umount -l "$KF" 2>/dev/null
  ! mounted
}

# "name<TAB>KeyConstant" for every shortcut button this firmware knows, read out
# of appLaunch.js itself rather than hardcoded, so it follows the TV.
#
# The line naming the button differs by release - webOS 9 assigns it to
# powerOnReason, webOS 4 straight to appId - and both are matched.
key_table() {
  awk '
    # Only inside the function that resolves a shortcut key to its app. The
    # file assigns appId in plenty of other handlers - settings, factory keys -
    # and reading those would offer buttons that are not shortcut buttons.
    /function (getPowerOnReason|handleCPHotkeys)/ { infn = 1; next }
    infn && /^}/ { infn = 0 }
    infn && /case WebOS\.Key_webOS_[A-Za-z0-9_]+:/ {
      k = $0; sub(/.*Key_webOS_/, "", k); sub(/:.*/, "", k); pending = k; next
    }
    infn && pending != "" && /(powerOnReason|appId) = "/ {
      r = $0; sub(/.*(powerOnReason|appId) = "/, "", r); sub(/".*/, "", r)
      # A real button name is a bare word; an app id with dots is something else.
      if (r != "" && r !~ /\./) { print r "\t" pending }
      pending = ""
    }
  ' "$APPLAUNCH"
}

# The buttons this model and its remote actually have, from the isActive flag on
# the TV's own mapping table, joined to the key constants above.
#
# The settings read comes back empty every so often - seen repeatedly on a C2,
# where an identical call returns 8KB or nothing - so it is retried, and the last
# good answer is kept and reused. Reporting no buttons because of one flaky read
# would empty the list in the dashboard for no reason.
buttons_json() {
  n=0
  while [ "$n" -lt 3 ]; do
    luna-send -n 1 -w 8000 -f \
      luna://com.webos.settingsservice/getSystemSettings \
      '{"category":"other","keys":["mapping_info"]}' > "$DIR/map.json" 2>/dev/null
    [ -s "$DIR/map.json" ] && break
    n=$((n + 1))
    sleep 1
  done
  # A real answer is cached and reused; where the TV has no such table at all -
  # webOS 4 returns "no matched result from DB" - the helper falls back to every
  # button the firmware knows, which is the best list available there.
  if [ -s "$DIR/map.json" ] && grep -q mapping_info "$DIR/map.json" 2>/dev/null; then
    cp -f "$DIR/map.json" "$DIR/map.good.json"
  elif [ -s "$DIR/map.good.json" ]; then
    cp -f "$DIR/map.good.json" "$DIR/map.json"
  fi
  key_table > "$DIR/keys.tsv"
  node "$BUTTONS_JS" "$DIR/map.json" "$DIR/keys.tsv" 2>/dev/null || echo '[]'
}

# Strict, because both values are pasted into generated JavaScript below.
valid_name() { echo "$1" | grep -qE '^[A-Za-z0-9._-]{1,64}$'; }

key_for() { awk -F'\t' -v b="$1" '$1 == b { print $2; exit }' "$DIR/keys.tsv" 2>/dev/null; }

# Build a patched copy from the pristine one, one case per binding.
build() {
  [ -f "$STOCK" ] || return 1
  cp -f "$STOCK" "$WORK"
  [ -s "$BINDINGS" ] || { mv -f "$WORK" "$STAGED"; return 0; }

  cases="$DIR/cases.txt"
  : > "$cases"
  # Names of their own: the caller's $button and $appid are still needed for its
  # reply once this returns, and a read loop would leave them empty at EOF.
  while IFS='	' read -r bname bapp; do
    [ -n "$bname" ] || continue
    valid_name "$bname" || continue
    valid_name "$bapp" || continue
    kc=$(key_for "$bname")
    [ -n "$kc" ] || continue
    valid_name "$kc" || continue
    {
      printf '    case WebOS.Key_webOS_%s: %s\n' "$kc" "$MARKER"
      printf '        if (pressed && !autoRepeat)\n'
      printf '            applicationManager.launch("%s", JSON.stringify({}));\n' "$bapp"
      printf '        return KeyPolicy.Accepted;\n'
      printf '\n'
    } >> "$cases"
  done < "$BINDINGS"

  [ -s "$cases" ] || { mv -f "$WORK" "$STAGED"; return 0; }

  awk -v casefile="$cases" '
    /function handleSystemKeys/ { infn = 1 }
    infn && !done && /switch \(key\)/ {
      print                                   # the switch itself, then ours
      while ((getline line < casefile) > 0) print line
      close(casefile)
      done = 1
      next
    }
    { print }
  ' "$WORK" > "$CHECK" || return 1
  rm -f "$WORK"

  syntax_ok "$CHECK" || { rm -f "$CHECK"; return 1; }
  grep -q "$MARKER" "$CHECK" || { rm -f "$CHECK"; return 1; }
  mv -f "$CHECK" "$STAGED"
}

# Would this file parse? A key filter that does not takes the compositor down
# with it, so nothing is ever mounted without passing here.
#
# webOS 4 ships node 0.12, which has no --check, so the fallback compiles the
# source instead: building a Function from it raises on a syntax error and never
# runs the body, which matters because the body expects QML globals.
syntax_ok() {
  node --check "$1" 2>/dev/null && return 0
  node -e 'var fs=require("fs");try{new Function(fs.readFileSync(process.argv[1],"utf8"));}catch(e){process.exit(1);}' \
       "$1" 2>/dev/null
}

# Reload the compositor so it reads the key handler again. webOS 9 is systemd,
# webOS 4 is upstart; --no-block matters only on the former, where stopping it
# otherwise waits on the whole cgroup.
reload() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart --no-block surface-manager 2>/dev/null
  else
    initctl restart surface-manager >/dev/null 2>&1
  fi
  return 0
}

compositor_running() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet surface-manager 2>/dev/null
  else
    initctl status surface-manager 2>/dev/null | grep -q 'start/running'
  fi
}

# Unmount first so $KF is the stock file for both the copy and the rebuild, and
# so the staged file being replaced is not the one currently mounted.
#
# $1 = "noreload" to leave the compositor alone, which is right at boot when it
# has not started yet: the mount is already in place when it first reads the
# file, so there is nothing to re-read and no restart to sit through.
apply() {
  unmount_kf || return 1
  save_stock || return 1
  build || return 1
  # With nothing bound the stock file is what should be there, so leave it.
  [ -s "$BINDINGS" ] || { [ "$1" = noreload ] || reload; return 0; }
  mount --bind "$STAGED" "$KF" 2>/dev/null || return 1
  [ "$1" = noreload ] || reload
}

revert() {
  rm -f "$BINDINGS"
  unmount_kf || return 1
  reload
}

mkdir -p "$DIR"

case "$1" in
  status)
    s=false; supported && s=true
    a=false; mounted && a=true
    b='[]'
    [ "$s" = true ] && b=$(buttons_json)
    printf '{"ok":true,"supported":%s,"active":%s,"defaultApp":"%s","buttons":%s,"bindings":[' \
      "$s" "$a" "$DEFAULT_APP" "$b"
    first=1
    if [ -f "$BINDINGS" ]; then
      while IFS='	' read -r button appid; do
        [ -n "$button" ] || continue
        [ $first -eq 1 ] || printf ','
        printf '{"button":"%s","appId":"%s"}' "$button" "$appid"
        first=0
      done < "$BINDINGS"
    fi
    printf ']}\n'
    ;;

  set)
    supported || json_err "not supported on this TV"
    button="$2"; appid="${3:-$DEFAULT_APP}"
    valid_name "$button" || json_err "bad button name"
    valid_name "$appid"  || json_err "bad app id"
    # keys.tsv is written by buttons_json; make sure it exists before lookup.
    [ -s "$DIR/keys.tsv" ] || buttons_json > /dev/null
    [ -n "$(key_for "$button")" ] || json_err "this TV has no such shortcut button"
    touch "$BINDINGS"
    grep -v "^$button	" "$BINDINGS" > "$BINDINGS.tmp" 2>/dev/null
    mv -f "$BINDINGS.tmp" "$BINDINGS"
    printf '%s\t%s\n' "$button" "$appid" >> "$BINDINGS"
    if apply; then printf '{"ok":true,"button":"%s","appId":"%s"}\n' "$button" "$appid"
    else json_err "could not apply the change"; fi
    ;;

  clear)
    button="$2"
    valid_name "$button" || json_err "bad button name"
    if [ -f "$BINDINGS" ]; then
      grep -v "^$button	" "$BINDINGS" > "$BINDINGS.tmp" 2>/dev/null
      mv -f "$BINDINGS.tmp" "$BINDINGS"
      [ -s "$BINDINGS" ] || rm -f "$BINDINGS"
    fi
    if apply; then printf '{"ok":true,"button":"%s","cleared":true}\n' "$button"
    else json_err "could not apply the change"; fi
    ;;

  clearall)
    if revert; then echo '{"ok":true,"active":false}'
    else json_err "could not restore the stock key handler; reboot to clear"; fi
    ;;

  boot)
    [ -s "$BINDINGS" ] || exit 0
    supported || exit 0
    buttons_json > /dev/null      # refresh keys.tsv before the lookup
    # Racing the compositor on purpose: mounting before it starts saves a
    # restart, and losing the race only costs the restart we would have done.
    if compositor_running; then apply; else apply noreload; fi
    ;;

  *)
    echo '{"ok":false,"error":"usage: shortcut-key.sh status|set <button> [appId]|clear <button>|clearall|boot"}'
    exit 1
    ;;
esac
