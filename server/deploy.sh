#!/bin/bash
#
# Push tvweb to the TV and (re)start it.
#
# Prefers SSH: if key-based login works, files go over scp and commands over
# ssh. That is the recommended setup - see the Security section of the README.
#
# Falls back to the Homebrew Channel's root telnet on port 23 for TVs that
# have not enabled SSH. That path serves the files over HTTP from this machine
# for a few seconds, because telnet gives us no file transfer.
#
# Usage: ./deploy.sh <tv-ip> [--persist] [--telnet]
#   --persist  also install the boot hook so it survives a reboot
#   --telnet   force the telnet path even if SSH is available

set -e

TV=""
PERSIST=""
FORCE_TELNET=""
for a in "$@"; do
  case "$a" in
    --persist) PERSIST=1 ;;
    --telnet)  FORCE_TELNET=1 ;;
    -*)        echo "unknown option: $a" >&2; exit 2 ;;
    *)         TV="$a" ;;
  esac
done
if [ -z "$TV" ]; then
  echo "usage: $0 <tv-ip> [--persist] [--telnet]" >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8771
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)

# ---------------------------------------------------------------- transport
use_ssh() {
  [ -n "$FORCE_TELNET" ] && return 1
  ssh "${SSH_OPTS[@]}" "root@$TV" true >/dev/null 2>&1
}

tvsh() {   # run stdin on the TV over the homebrew root telnet
  { printf '\n'; sleep 1; cat; printf '\nexit\n'; sleep "${W:-8}"; } \
    | nc -w $(( ${W:-8} + 5 )) "$TV" 23 2>/dev/null | LC_ALL=C tr -d '\r'
}

# Python 3 under whichever name this computer gives it. Windows installs it as
# `python`, and its `python3` can be a stub that only opens the Microsoft Store,
# so each candidate is asked to prove it rather than merely exist.
pick_python() {
  for p in python3 python; do
    if "$p" -c 'import sys, http.server; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then
      echo "$p"
      return
    fi
  done
}
PY=$(pick_python)

# The telnet route needs two things from this computer, and either one missing
# used to fail silently inside a pipe while the run reported success.
check_telnet_tools() {
  missing=""
  command -v nc >/dev/null 2>&1 ||
    missing="$missing
  - netcat (the nc command), which sends the install commands to the TV"
  [ -n "$PY" ] ||
    missing="$missing
  - Python 3, which hands the files to the TV while it downloads them"
  [ -z "$missing" ] && return 0
  cat >&2 <<EOF

Can't install over telnet: this computer is missing$missing

Either turn on SSH on the TV - deploy.sh then needs neither of these - or run
this from WSL, macOS or Linux, which have both. SSH setup is in
docs/SECURITY.md, under "Moving from telnet to SSH".
EOF
  exit 1
}

start_http() {
  ( "$PY" -m http.server "$PORT" --directory "$DIR" --bind 0.0.0.0 >/dev/null 2>&1 &
    echo $! > /tmp/.tvweb_httpd )
  sleep 1
}
stop_http() { kill "$(cat /tmp/.tvweb_httpd 2>/dev/null)" 2>/dev/null || true; rm -f /tmp/.tvweb_httpd; }

FILES="tvweb.js tvwebctl assets/ui.html assets/fonts/Outfit.ttf assets/fonts/Manrope.ttf \
assets/fonts/OFL-Outfit.txt assets/fonts/OFL-Manrope.txt \
assets/screensavers/clock.qml assets/screensavers/fireworks.qml \
assets/screensavers/starfield.qml assets/screensavers/vitals.qml assets/screensavers/star.png \
lib/mqtt.js lib/ha.js lib/updater.js lib/privacy.js lib/oled.js lib/screensavers.js lib/telemetry.js \
lib/luna.js lib/state.js lib/mqtt-state.js lib/notifications.js"

# ---------------------------------------------------------------- ssh path
deploy_ssh() {
  echo "deploying to $TV over ssh ..."
  ssh "${SSH_OPTS[@]}" "root@$TV" 'mkdir -p /var/lib/tvweb/assets/fonts /var/lib/tvweb/assets/screensavers /var/lib/tvweb/lib'
  for f in $FILES; do
    scp "${SSH_OPTS[@]}" -q "$DIR/$f" "root@$TV:/var/lib/tvweb/$f"
  done
  # Locate target-specific config (e.g. config.192.168.1.13.json) or fall back to config.json.
  # Only copy if the TV does not already have one: overwriting an existing
  # config wipes out that TV's unique device id and topic prefix.
  CONFIG_FILE=""
  if [ -f "$DIR/config.$TV.json" ]; then
    CONFIG_FILE="$DIR/config.$TV.json"
  elif [ -f "$DIR/config.json" ]; then
    CONFIG_FILE="$DIR/config.json"
  fi
  if [ -n "$CONFIG_FILE" ]; then
    if ! ssh "${SSH_OPTS[@]}" "root@$TV" '[ -f /var/lib/tvweb/config.json ]'; then
      echo "initializing config from $(basename "$CONFIG_FILE") ..."
      scp "${SSH_OPTS[@]}" -q "$CONFIG_FILE" "root@$TV:/var/lib/tvweb/config.json"
      ssh "${SSH_OPTS[@]}" "root@$TV" 'chmod 600 /var/lib/tvweb/config.json'
    fi
  fi

  if [ -n "$PERSIST" ]; then
    ssh "${SSH_OPTS[@]}" "root@$TV" 'mkdir -p /var/lib/webosbrew/init.d'
    # run-parts ignores filenames containing a dot, so the hook must not end .sh
    scp "${SSH_OPTS[@]}" -q "$DIR/50-tvweb.sh" "root@$TV:/var/lib/webosbrew/init.d/50-tvweb"
    ssh "${SSH_OPTS[@]}" "root@$TV" 'chmod +x /var/lib/webosbrew/init.d/50-tvweb'
    echo "boot hook installed"
  fi

  # Restart via the on-TV control script. Doing this inline over ssh does not
  # work: any pkill pattern matching tvweb.js also matches the remote shell,
  # whose argv contains that path, so it kills itself first.
  ssh "${SSH_OPTS[@]}" "root@$TV" '
    chmod +x /var/lib/tvweb/tvwebctl
    /var/lib/tvweb/tvwebctl restart
    sleep 4
    /var/lib/tvweb/tvwebctl status
    tail -6 /var/lib/tvweb/tvweb.log'
}

# ---------------------------------------------------------------- telnet path

# The telnet path has no file transfer, so the TV pulls the files back over HTTP
# and we need the LAN address it can reach us on. Every way of asking is
# platform-specific and one of them lies: under Git Bash, `ipconfig getifaddr`
# runs Windows' ipconfig.exe, which ignores the arguments and prints its help
# text to stdout - so candidates are checked for the shape of an address rather
# than merely being non-empty. Set MYIP to skip all of this.
local_ip() {
  tmp=$(mktemp)
  { for i in en0 en1 en2 en3; do ipconfig getifaddr "$i"; done      # macOS
    hostname -I | tr ' ' '\n'                                       # Linux
    ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}'
    ipconfig | sed -n 's/.*IPv4 Address[^:]*: *\([0-9.]*\).*/\1/p'  # Windows
  } 2>/dev/null | grep -Ex '([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -v '^127\.' > "$tmp"

  # Prefer an address on the TV's own subnet: Windows machines routinely carry
  # WSL, Hyper-V and VPN adapters the TV cannot route back to.
  awk -v p="${TV%.*}." 'index($0, p) == 1 { print; hit = 1; exit }
                        END { if (!hit) exit 1 }' "$tmp" || head -1 "$tmp"
  rm -f "$tmp"
}

deploy_telnet() {
  MYIP="${MYIP:-$(local_ip)}"
  [ -z "$MYIP" ] && {
    echo "could not work out this machine's LAN IP - rerun as MYIP=192.168.x.y $0 $TV" >&2
    exit 1; }
  check_telnet_tools
  echo "deploying to $TV over telnet; the TV downloads the files from $MYIP:$PORT ..."
  start_http
  trap stop_http EXIT

  CONFIG_FILE=""
  if [ -f "$DIR/config.$TV.json" ]; then
    CONFIG_FILE="$DIR/config.$TV.json"
  elif [ -f "$DIR/config.json" ]; then
    CONFIG_FILE="$DIR/config.json"
  fi
  CONFIG_NAME=""
  [ -n "$CONFIG_FILE" ] && CONFIG_NAME="$(basename "$CONFIG_FILE")"

  # NOTE: this heredoc is unquoted so $MYIP/$PORT expand HERE. Anything that
  # must run on the TV has to be escaped (\$f, \$(...)).
  out=$(W=16 tvsh <<TVCMDS
mkdir -p /var/lib/tvweb/assets/fonts /var/lib/tvweb/assets/screensavers /var/lib/tvweb/lib
wget -q -O /var/lib/tvweb/tvweb.js http://$MYIP:$PORT/tvweb.js && echo "tvweb.js \$(wc -c < /var/lib/tvweb/tvweb.js) bytes"
wget -q -O /var/lib/tvweb/assets/ui.html http://$MYIP:$PORT/assets/ui.html && echo "ui.html \$(wc -c < /var/lib/tvweb/assets/ui.html) bytes"
wget -q -O /var/lib/tvweb/tvwebctl http://$MYIP:$PORT/tvwebctl
for f in mqtt.js ha.js updater.js privacy.js oled.js screensavers.js telemetry.js \
           luna.js state.js mqtt-state.js notifications.js; do
  wget -q -O /var/lib/tvweb/lib/\$f http://$MYIP:$PORT/lib/\$f
done
echo "lib: \$(ls /var/lib/tvweb/lib | wc -l) files"
for f in Outfit.ttf Manrope.ttf OFL-Outfit.txt OFL-Manrope.txt; do
  wget -q -O /var/lib/tvweb/assets/fonts/\$f http://$MYIP:$PORT/assets/fonts/\$f
done
echo "fonts: \$(ls /var/lib/tvweb/assets/fonts | wc -l) files"
for f in clock.qml fireworks.qml starfield.qml vitals.qml star.png; do
  wget -q -O /var/lib/tvweb/assets/screensavers/\$f http://$MYIP:$PORT/assets/screensavers/\$f
done
echo "screensavers: \$(ls /var/lib/tvweb/assets/screensavers | wc -l) files"
$([ -n "$CONFIG_NAME" ] && echo "[ -f /var/lib/tvweb/config.json ] || (wget -q -O /var/lib/tvweb/config.json http://$MYIP:$PORT/$CONFIG_NAME && echo 'config initialized from $CONFIG_NAME')")
chmod 600 /var/lib/tvweb/config.json 2>/dev/null
$([ -n "$PERSIST" ] && echo "mkdir -p /var/lib/webosbrew/init.d && wget -q -O /var/lib/webosbrew/init.d/50-tvweb http://$MYIP:$PORT/50-tvweb.sh && chmod +x /var/lib/webosbrew/init.d/50-tvweb && echo 'boot hook installed'")
chmod +x /var/lib/tvweb/tvwebctl
/var/lib/tvweb/tvwebctl restart
sleep 4
/var/lib/tvweb/tvwebctl status
tail -6 /var/lib/tvweb/tvweb.log
TVCMDS
)
  stop_http
  trap - EXIT
  [ -n "$out" ] && printf '%s\n' "$out"

  # Telnet reports nothing on its own, so the TV's own account of what it
  # downloaded is the only evidence the install happened.
  if [ -z "$out" ]; then
    cat >&2 <<EOF

Couldn't reach the TV over telnet. Check that the TV is on and that its address
is right, and that telnet is switched on in the Homebrew Channel's settings.
EOF
    exit 1
  fi
  if ! printf '%s\n' "$out" | grep -Eq '^tvweb\.js [1-9][0-9]* bytes'; then
    cat >&2 <<EOF

The TV answered, but couldn't download the files from this computer
($MYIP, port $PORT). A firewall is the usual cause: on Windows, allow Python
through Windows Defender Firewall when it asks, or set up SSH instead - see
docs/SECURITY.md, under "Moving from telnet to SSH".
EOF
    exit 1
  fi
}

# ---------------------------------------------------------------- go
if use_ssh; then
  deploy_ssh
else
  if [ -z "$FORCE_TELNET" ]; then
    echo "SSH isn't set up on this TV, so installing over telnet instead." >&2
    echo "(SSH is safer - see \"Moving from telnet to SSH\" in docs/SECURITY.md.)" >&2
  fi
  deploy_telnet
fi

echo
# With the dashboard switched off there is no HTTP endpoint to poll, so report
# the log instead of a false failure.
WEB_OFF=""
if [ -f "$DIR/config.json" ] && [ -n "$PY" ]; then
  WEB_OFF=$("$PY" -c 'import json,sys
try:
    c = json.load(open(sys.argv[1]))
    print("1" if c.get("web", {}).get("enabled") is False else "")
except Exception:
    print("")' "$DIR/config.json" 2>/dev/null || true)
fi

echo "verifying ..."
if [ -n "$WEB_OFF" ]; then
  echo "dashboard disabled in config (web.enabled=false) - mqtt bridge only."
  if use_ssh; then
    ssh "${SSH_OPTS[@]}" "root@$TV" 'tail -4 /var/lib/tvweb/tvweb.log' 2>/dev/null
  fi
elif ! command -v curl >/dev/null 2>&1; then
  echo "(skipped: this computer has no curl to ask the dashboard with)"
  echo "open  http://$TV:8080/"
else
  # A restart takes a few seconds, so give it twenty before calling it a failure.
  answered=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if caps=$(curl -sf --max-time 4 "http://$TV:8080/api/caps"); then answered=1; break; fi
    sleep 2
  done
  if [ -z "$answered" ]; then
    cat >&2 <<EOF

The files were installed, but the dashboard at http://$TV:8080/ didn't answer
within 20 seconds. Check that the TV is on, then run this again.
EOF
    exit 1
  fi
  echo "$caps"
  echo
  echo "done - open http://$TV:8080/"
fi
