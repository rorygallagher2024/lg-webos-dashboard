#!/bin/sh
# webosbrew boot hook: start the tvweb monitor server.
# Install to /var/lib/webosbrew/init.d/50-tvweb (chmod +x).
# Note: BusyBox run-parts ignores filenames containing a dot (.),
# so this hook must not have a .sh extension in init.d.
# Remove /var/lib/webosbrew/init.d/50-tvweb to uninstall.
# Nothing on the read-only rootfs is touched.
#
# Deliberately defensive: never block boot, never respawn-loop. If the
# server is missing or node is gone, this exits quietly.

[ -x /usr/bin/node ] || exit 0
[ -f /var/lib/tvweb/tvweb.js ] || exit 0

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:$PATH"

# Hold down the LG daemons switched off in the dashboard. Done in the delayed
# block below, after upstart has had its go at starting them.

# Restore adblock bind-mount if enabled
if [ -f /var/lib/tvweb/adblock_enabled ] && [ -f /var/lib/tvweb/adblock_hosts ]; then
  mount --bind /var/lib/tvweb/adblock_hosts /etc/hosts 2>/dev/null || true
fi

# Restore the chosen screen saver. The app directory is on the read-only
# overlay, so the replacement is a bind mount and does not survive a reboot.
#
# sam.service is up well before this hook runs and reads each appinfo.json only
# once, so where the replacement changes the app's type - as it does on a set
# whose screen saver ships as Flutter - it has to read the file again or the
# launch goes to the wrong runner and nothing draws. Comparing the manifest
# either side of the mount says exactly when that is, with no call onto the bus.
# Seconds into boot is the cheapest moment to restart it.
if [ -f /var/lib/tvweb/screensaver/.tvweb-screensaver ]; then
  ssapp=/usr/palm/applications/com.webos.app.screensaver
  stock_type=$(sed -n 's/.*"type"[^"]*"\([^"]*\)".*/\1/p' "$ssapp/appinfo.json" 2>/dev/null)
  mount --bind /var/lib/tvweb/screensaver "$ssapp" 2>/dev/null || true
  staged_type=$(sed -n 's/.*"type"[^"]*"\([^"]*\)".*/\1/p' "$ssapp/appinfo.json" 2>/dev/null)
  # --no-block: stopping sam waits on every app in its cgroup, which is most of
  # a minute, and no hook may hold up boot for that.
  if [ -n "$stock_type" ] && [ -n "$staged_type" ] && [ "$stock_type" != "$staged_type" ]; then
    systemctl restart --no-block sam >/dev/null 2>&1 || true
  fi
fi

# Detach fully so upstart/webosbrew startup is never held up by this.
# Prefer tvwebctl: it starts the watchdog alongside the server. The direct
# line stays as a fallback for installs that predate that script.
(
  # A short buffer so the server does not contend with the busiest part of boot,
  # then start: the sooner it is up, the sooner Home Assistant has the TV's state
  # after a power-on (and the sooner the launcher, if it is the home, can load).
  # The server retries MQTT, so it is fine to start before the network settles.
  sleep 5
  /usr/bin/pkill -9 -f tvweb.js 2>/dev/null || true
  sleep 1
  if [ -f /var/lib/tvweb/services_stopped ]; then
    while read -r job; do
      [ -n "$job" ] && /sbin/initctl stop "$job" >/dev/null 2>&1
    done < /var/lib/tvweb/services_stopped
  fi

  # Re-apply the launcher-as-Home choice made in the dashboard. The compositor is
  # up by now, so this reloads it once; the script self-guards and never loops.
  if [ -f /var/lib/tvweb/home/enabled ]; then
    sh /var/lib/tvweb/assets/launcher-app/home-mode.sh boot >/dev/null 2>&1 || true
  fi

  if [ -x /var/lib/tvweb/tvwebctl ]; then
    /var/lib/tvweb/tvwebctl start
  else
    setsid /usr/bin/node /var/lib/tvweb/tvweb.js \
      > /var/lib/tvweb/tvweb.log 2>&1 &
  fi
) &

exit 0
