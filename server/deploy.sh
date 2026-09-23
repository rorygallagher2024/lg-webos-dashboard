#!/bin/bash
#
# Install tvweb on the TV, or update it, and start it.
#
# The files go over as one bundle and are unpacked on the TV by the same few
# lines whichever way they get there:
#
#   SSH     when key-based login works - the recommended setup, see "Moving
#           from telnet to SSH" in docs/SECURITY.md.
#   telnet  otherwise, through the Homebrew Channel's root shell. Telnet has no
#           file transfer, so the bundle is sent down the connection as text
#           and decoded on the TV.
#
# Neither needs anything on this computer beyond bash and its standard tools,
# which Git Bash on Windows has, and neither needs the TV to reach the internet.
#
# Usage: ./deploy.sh <tv-ip> [--no-persist] [--telnet] [--app|--no-app]
#   --no-persist  skip the boot hook, so the server does not come back after
#                 the TV restarts
#   --telnet      use telnet even when SSH works
#   --app         add the dashboard app to the TV's home screen
#   --no-app      leave the home screen alone
# By default a first install adds the app and an update leaves the home screen
# as it is, so re-deploying never puts back an app removed from the Server tab.

set -e

TV=""
PERSIST=1
FORCE_TELNET=""
APP_MODE=auto     # auto: add on a first install, leave an update alone
for a in "$@"; do
  case "$a" in
    --persist)    PERSIST=1 ;;          # the default; still accepted
    --no-persist) PERSIST="" ;;
    --telnet)     FORCE_TELNET=1 ;;
    --app)        APP_MODE=yes ;;
    --no-app)     APP_MODE=no ;;
    -*)           echo "unknown option: $a" >&2; exit 2 ;;
    *)            TV="$a" ;;
  esac
done
if [ -z "$TV" ]; then
  echo "usage: $0 <tv-ip> [--no-persist] [--telnet] [--app|--no-app]" >&2
  echo "  <tv-ip> is the TV's address, from Settings > Network on the TV." >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)
STAGE=/var/lib/tvweb/.deploy     # on the TV; beside the install so moves are renames

FILES="tvweb.js tvwebctl assets/ui.html assets/dashboard.html \
assets/qr.js assets/setup.html assets/setup-phone.html \
assets/dashboard-app/appinfo.json assets/dashboard-app/index.html \
assets/dashboard-app/packageinfo.json assets/dashboard-app/install-app.sh \
assets/dashboard-app/assets/icon80.png assets/dashboard-app/assets/icon130.png \
assets/fonts/Outfit.ttf assets/fonts/Manrope.ttf \
assets/fonts/Outfit-Light.ttf assets/fonts/Outfit-Regular.ttf \
assets/fonts/Manrope-Regular.ttf assets/fonts/Manrope-SemiBold.ttf \
assets/fonts/OFL-Outfit.txt assets/fonts/OFL-Manrope.txt \
assets/screensavers/clock.qml assets/screensavers/fireworks.qml \
assets/screensavers/starfield.qml assets/screensavers/vitals.qml assets/screensavers/star.png \
lib/mqtt.js lib/ha.js lib/updater.js lib/privacy.js lib/oled.js lib/screensavers.js lib/telemetry.js \
lib/apps.js lib/luna.js lib/state.js lib/mqtt-state.js lib/notifications.js lib/services.js"

for t in tar base64 fold; do
  command -v "$t" >/dev/null 2>&1 && continue
  echo "Can't install: this computer has no '$t' command. Every Mac, Linux machine" >&2
  echo "and Git Bash window on Windows has one, so try one of those." >&2
  exit 1
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- the bundle
mkdir -p "$WORK/b"
for f in $FILES; do
  mkdir -p "$WORK/b/$(dirname "$f")"
  cp "$DIR/$f" "$WORK/b/$f"
done
cp "$DIR/50-tvweb.sh" "$WORK/b/50-tvweb.sh"
# A config for this particular TV wins over the general one. Either is only
# used where the TV has none yet: its own holds its device id and topics.
if [ -f "$DIR/config.$TV.json" ]; then
  cp "$DIR/config.$TV.json" "$WORK/b/config.seed.json"
elif [ -f "$DIR/config.json" ]; then
  cp "$DIR/config.json" "$WORK/b/config.seed.json"
fi
# ustar is the plainest format, and both the GNU tar on webOS 4 and the BusyBox
# tar on webOS 9 read it. COPYFILE_DISABLE stops macOS adding its ._ files.
( cd "$WORK/b" && COPYFILE_DISABLE=1 tar --format=ustar -cf "$WORK/bundle.tar" . )

SUM=""
if command -v md5sum >/dev/null 2>&1; then
  SUM=$(md5sum < "$WORK/bundle.tar" | cut -d' ' -f1)
elif command -v md5 >/dev/null 2>&1; then
  SUM=$(md5 -q "$WORK/bundle.tar")
fi

# What runs on the TV once the bundle is there, whichever way it arrived. It
# reports with TVWEB_ lines, which are how this script learns what happened.
install_script() {
  cat <<EOF
S=$STAGE
D=/var/lib/tvweb
fail() { echo "TVWEB_FAIL \$1"; cd /; rm -rf "\$S"; exit 1; }
cd "\$S" || fail "the files did not arrive"
# Before anything is unpacked, so it records whether tvweb was already here.
FRESH=""
[ -f "\$D/tvweb.js" ] || FRESH=1
if [ -n "$SUM" ] && [ "\$(md5sum < bundle.tar | cut -d' ' -f1)" != "$SUM" ]; then
  fail "the files arrived damaged"
fi
mkdir -p x && tar -xof bundle.tar -C x || fail "the TV could not unpack the files"
cd x
# Renamed into place, never written over: BusyBox's shell reads a script as it
# runs it, so overwriting tvwebctl would corrupt the watchdog running out of it.
for f in \$(find . -type f); do
  case "\$f" in ./config.seed.json|./50-tvweb.sh) continue ;; esac
  mkdir -p "\$D/\$(dirname "\$f")"
  mv -f "\$f" "\$D/\$f"
done
if [ ! -f "\$D/config.json" ] && [ -f config.seed.json ]; then
  mv config.seed.json "\$D/config.json" && echo "config set up from this computer's copy"
fi
chmod 600 "\$D/config.json" 2>/dev/null
chmod +x "\$D/tvwebctl"
if [ -n "$PERSIST" ]; then
  mkdir -p /var/lib/webosbrew/init.d
  # run-parts skips names with a dot in them, so the copy in progress never runs.
  cp 50-tvweb.sh /var/lib/webosbrew/init.d/.50-tvweb.new &&
    chmod +x /var/lib/webosbrew/init.d/.50-tvweb.new &&
    mv -f /var/lib/webosbrew/init.d/.50-tvweb.new /var/lib/webosbrew/init.d/50-tvweb &&
    echo "boot hook installed"
fi
echo "TVWEB_INSTALLED \$(wc -c < "\$D/tvweb.js")"
cd / && rm -rf "\$S"
"\$D/tvwebctl" restart
sleep 4
"\$D/tvwebctl" status
tail -6 "\$D/tvweb.log"
# How this TV's own config exposes the dashboard, so the check at the end asks
# for it only where it can answer. The TV keeps its own config.json, which is
# the one that counts, not the copy on this computer.
if tr -d ' \t\r\n' < "\$D/config.json" 2>/dev/null | grep -q '"web":{[^}]*"enabled":false'; then
  echo "TVWEB_WEB_OFF"
elif tr -d ' \t\r\n' < "\$D/config.json" 2>/dev/null | grep -qE '"host":"(127\.[0-9.]*|localhost|::1)"'; then
  echo "TVWEB_WEB_LOCAL"
fi
# Added on a first install, left alone on an update, so removing it from the
# Server tab sticks. Never fails the install: the dashboard is served to
# browsers whether or not the TV has a tile for it.
case "$APP_MODE" in
  yes) doapp=1 ;;
  no)  doapp="" ;;
  *)   doapp="\$FRESH" ;;
esac
[ -n "\$doapp" ] && { sh "\$D/assets/dashboard-app/install-app.sh" install 2>&1 || true; }
EOF
}

# ---------------------------------------------------------------- SSH
use_ssh() {
  [ -n "$FORCE_TELNET" ] && return 1
  command -v ssh >/dev/null 2>&1 || return 1
  ssh "${SSH_OPTS[@]}" "root@$TV" true >/dev/null 2>&1
}

deploy_ssh() {
  echo "installing on $TV over SSH ..."
  # shellcheck disable=SC2029  # $STAGE is a fixed path, meant to be filled in here
  ssh "${SSH_OPTS[@]}" "root@$TV" "mkdir -p $STAGE && cat > $STAGE/bundle.tar" < "$WORK/bundle.tar"
  install_script | ssh "${SSH_OPTS[@]}" "root@$TV" 'sh -s' > "$WORK/out" 2>&1 || true
}

# ---------------------------------------------------------------- telnet
# Does anything answer on this port within six seconds? A connection to an
# address nothing is using would otherwise hang for over a minute.
answers() {
  ( exec 3<>"/dev/tcp/$TV/$1" ) 2>/dev/null &
  p=$!
  for _ in 1 2 3 4 5 6; do
    sleep 1
    if ! kill -0 "$p" 2>/dev/null; then
      wait "$p"
      return $?
    fi
  done
  kill "$p" 2>/dev/null
  return 1
}

deploy_telnet() {
  if ! answers 23; then
    cat >&2 <<EOF

Couldn't reach the TV. Check that it is on and that $TV is its address
(Settings > Network on the TV). If it is, telnet may be switched off in the
Homebrew Channel's settings: switch it on, or set up SSH - see "Moving from
telnet to SSH" in docs/SECURITY.md.
EOF
    exit 1
  fi
  if [ -z "$FORCE_TELNET" ]; then
    echo "SSH isn't set up on this TV, so installing over telnet instead."
    echo "(SSH is safer - see \"Moving from telnet to SSH\" in docs/SECURITY.md.)"
  fi
  echo "installing on $TV over telnet ..."

  # bash can open a network connection itself, so no telnet program is needed.
  exec 3<>"/dev/tcp/$TV/23"
  cat <&3 > "$WORK/raw" &      # read while writing, so neither side can stall
  reader=$!
  sleep 1
  {
    # No prompts and no echo: otherwise every line sent comes straight back, and
    # the shell prints a continuation prompt for each line of the bundle.
    printf 'PS1=; PS2=; stty -echo; echo __TVWEB_START__\n'
    sleep 1
    printf "mkdir -p %s && base64 -d > %s/bundle.tar <<'__TVWEB_B64__'\n" "$STAGE" "$STAGE"
    base64 < "$WORK/bundle.tar" | fold -w 76
    printf '__TVWEB_B64__\n'
    printf "cat > %s/install.sh <<'__TVWEB_SH__'\n" "$STAGE"
    install_script
    printf '__TVWEB_SH__\n'
    printf 'sh %s/install.sh; echo __TVWEB_DONE__; exit\n' "$STAGE"
  } >&3

  for _ in $(seq 1 90); do
    grep -q '__TVWEB_DONE__' "$WORK/raw" 2>/dev/null && break
    sleep 1
  done
  exec 3>&-
  kill "$reader" 2>/dev/null || true
  wait "$reader" 2>/dev/null || true
  # Only what the TV printed once the install began: before that come telnet's
  # control bytes, the login banner and the first command echoed back.
  LC_ALL=C tr -cd '\11\12\40-\176' < "$WORK/raw" |
    sed -n '/__TVWEB_START__/,$p' | grep -Ev '__TVWEB_(START|DONE)__' > "$WORK/out" || true
}

# ---------------------------------------------------------------- go
if use_ssh; then
  deploy_ssh
else
  deploy_telnet
fi

grep -v '^TVWEB_' "$WORK/out" | grep -v '^$' || true

fail=$(sed -n 's/^TVWEB_FAIL //p' "$WORK/out" | head -1)
if [ -n "$fail" ] || ! grep -Eq '^TVWEB_INSTALLED [1-9][0-9]*' "$WORK/out"; then
  cat >&2 <<EOF

Nothing was installed: ${fail:-the TV did not confirm it received the files}.
Run this again; if it keeps happening, check the TV is still on and connected.
EOF
  exit 1
fi

echo
# Where the TV will not answer on the network by design, skip the check rather
# than report a false failure.
if grep -q '^TVWEB_WEB_OFF' "$WORK/out"; then
  echo "installed; the dashboard is switched off in the TV's config.json, so there is nothing to open."
  exit 0
fi
if grep -q '^TVWEB_WEB_LOCAL' "$WORK/out"; then
  echo "installed; the dashboard answers only on the TV itself (\"host\" is loopback in its config.json)."
  exit 0
fi

echo "checking the dashboard answers ..."
if ! command -v curl >/dev/null 2>&1; then
  echo "(skipped: this computer has no curl to ask it with)"
  echo "open  http://$TV:8080/"
  exit 0
fi
# A restart takes a few seconds, so give it twenty before calling it a failure.
answered=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 4 "http://$TV:8080/api/caps" >/dev/null; then answered=1; break; fi
  sleep 2
done
if [ -z "$answered" ]; then
  cat >&2 <<EOF

The files were installed, but the dashboard at http://$TV:8080/ didn't answer
within 20 seconds. Check that the TV is on, then run this again.
EOF
  exit 1
fi
echo "done - open http://$TV:8080/"
