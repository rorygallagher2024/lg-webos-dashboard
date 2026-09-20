# Implementation notes

How this works on the inside, and the platform quirks that shaped it. Nothing
here is needed to use the project - see the [README](../README.md) for that.

---

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │          LG webOS TV (Rooted)           │
                  │              (Node 0.12)                │
                  │  ┌───────────────────┐ ┌─────────────┐  │
                  │  │ HTTP Dashboard UI │ │  MiniMQTT   │  │
                  │  │ (Port 8080)       │ │  Client     │  │
                  │  └─────────┬─────────┘ └──────┬──────┘  │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   In-Flight Concurrency Mutex & Caching │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   Direct execFile (luna-send -w 2000)   │
                  │      webOS Luna Bus & /proc telemetry   │
                  └───────────────────────────────┬─────────┘
                                                  │
                                    MQTT TCP 1883 │ (Telemetry + Controls)
                                                  ▼
                  ┌─────────────────────────────────────────┐
                  │          MQTT Broker / Mosquitto        │
                  └───────────────────────┬─────────────────┘
                                          │
                                          ▼
                  ┌─────────────────────────────────────────┐
                  │              Home Assistant             │
                  │      (Auto-Discovered Entities)         │
                  └─────────────────────────────────────────┘
```

### High-Stability Process Execution
Older Linux kernels and Node 0.12 can encounter process deadlocks or child leaks when `child_process.exec()` is called frequently (spawning `/bin/sh` without timeout parameters). 

`tvweb.js` solves this with:
1. **Direct `execFile`**: Invokes `/usr/bin/luna-send` directly with zero shell overhead.
2. **Internal Daemon Timeout**: Luna calls use `-w 2000` to prevent orphaned background processes if a system bus stalls.
3. **In-Flight Concurrency Mutex**: If multiple HTTP pollers or MQTT intervals request stats simultaneously, they are coalesced into a single execution pipeline.
4. **Memory Caching**: Telemetry is cached for 1.5 seconds, delivering sub-20ms HTTP responses with zero subprocess spawning during rapid UI updates.
5. **Deterministic MQTT Client Session**: Uses a static client ID and periodic availability reaffirmation so TV reboots or network reconnects never leave entities trapped in an "Unavailable" state.

---

---

## Platform constraints

- **Node.js v0.12 (2015)**: webOS 4.x ships Node v0.12.2. All code in `tvweb.js` is written in strict ES5 (no `let`/`const`, no arrow functions, no template literals, no `async`/`await`).
- **BusyBox `run-parts` Hook Naming**: The webosbrew startup system invokes user hooks with `run-parts /var/lib/webosbrew/init.d`. BusyBox `run-parts` strictly ignores any filename containing a dot (`.`), so the boot hook must be named `50-tvweb` without `.sh`.
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`, `com.webos.service.settings`, `com.webos.service.eim`).

---

---

## eMMC health vs wear

Under the **JEDEC eMMC 5.0** specification, `/sys/block/mmcblk0/device/life_time` returns byte estimates for SLC and MLC partition write cycles:
- `0x01` indicates **0% – 10% of rated device write cycles used**.
- This means **>90% of drive life remains** (Healthy).
- `pre_eol_info` returning `01` indicates normal endurance (<80% reserved blocks consumed).

To prevent user confusion, `tvweb.js` translates this into both a human-friendly health state (`>90% (Healthy)`) and a wear estimate (`0-10% used · Normal EOL`).

---

---

## Where the telemetry comes from

webOS 4.x has **no generic Linux thermal interface**. `/sys/class/thermal` exists
but is empty, and there is no `hwmon` at all, so any guide pointing at
`thermal_zone*/temp` returns nothing on this hardware. LG exposes its own tree
instead:

| Path | Meaning |
| :--- | :--- |
| `/proc/lg/pm/temperature` | SoC temperature, **plain °C** (not millidegrees) |
| `/proc/lg/pm/current_load` | CPU load, % |
| `/proc/lg/pm/frequency` | kHz |
| `/proc/lg/pm/status` | per-core load, governor, AVS currents |
| `/sys/block/mmcblk0/device/life_time` | eMMC wear (`0x01` = 0–10% used) |
| `/sys/block/mmcblk0/device/pre_eol_info` | `01` Normal / `02` Warning / `03` Urgent |
| `/mnt/lg/cmn_data/mrcu/mrcu1.info` | Magic Remote battery percentage, remote model, BDAddr, and firmware |
| `/proc/lg/hdmi20/port[0-3]/status` | Real-time HDMI receiver PHY mode (FRL 48 Gbps vs TMDS), chroma (RGB 4:4:4), HDCP, cable error counter, ALLM, VRR |
| `/proc/lg/pe/hdr_status` | Picture engine live video format, colorimetry standard (`BT.709`, `BT.2020`), and peak nit levels |
| `/var/luna/preferences/environmentCondition` | Hardware configuration (SoC generation `_O22_`, DDR RAM, refresh rate, eye sensor) |

**Do not read `/proc/lg/pm/ts_enable`** — it segfaults the reading process.

webOS 3.9 has no temperature source at all: `/proc/lg/pm/temperature` is absent,
nothing under `/proc/lg` or `/sys` is named for temperature, `/sys/class/thermal` is
empty, there is no `hwmon`, and `systemproperty` rejects every temperature key. The
server reports this as `capabilities.thermal: false` so the dashboard can distinguish
it from the ~80s post-boot window where the file exists but reads 0.

### /proc/stat is not monotonic

LG hot-plugs CPU cores (`/proc/lg/pm/mp_enable`), so the aggregate counters in
`/proc/stat` can go *backwards* between samples — the idle figure has been
observed dropping from 324186 to 228324 across two reads seconds apart. Any
delta-based CPU percentage built on it produces nonsense. `current_load` is the
figure to trust; `/proc/stat` is only used when every delta is non-negative.

## OLED panel counters, and their units

The panel timers do not share a unit, which is the single easiest thing to get
wrong here. Furthermore, webOS 9+ (webOS 22+, e.g. LG C2) moved several counters
to a dedicated service and changed filesystem file paths:

| Value | Older webOS (B8, 4.x–8.x) | Modern webOS (C2, 9.x / 22+) | Unit |
| :--- | :--- | :--- | :--- |
| **Panel usage time** | `com.webos.service.tv.systemproperty/getSystemProperties` (`panelUsageTime`) | `com.webos.service.panelcontroller/getPanelUsageTime` (`panelUsageTime`) | 10-minute units — divide by 6 for hours |
| **Last compensation** | `lastCompensationTimestamp` (Luna) | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | 10-minute units (Luna) / whole hours (fs) |
| **Off-RS hours (fs)** | `/mnt/lg/cmn_data/pnwash/autoOffRsTime` | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | whole panel **hours** |
| **Refresher hours (fs)**| `/mnt/lg/cmn_data/pnwash/autoPnwashTime` | `/mnt/lg/cmn_data/pnwash/autoJbLastTime` | whole panel **hours** |
| **Off-RS interval** | `/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode` (`24`) | `/mnt/lg/cmn_data/pnwash/autoOffRsInterval` (`4`) | 10-min units (older) / whole hours (newer) |
| **Refresher cadence** | Constant (2,000h) | `/mnt/lg/cmn_data/pnwash/autoJbInterval` (`2000 ok`) | whole panel **hours** |
| **Off-RS completed cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedOffRsCount` | integer count |
| **JB refresher cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedJbCount` | integer count |
| **Compensation failures** | &mdash; | `/mnt/lg/cmn_data/pnwash/failAlertCount` | integer count |
| **GSR stress events** | &mdash; | `com.webos.service.oledepl/getGlobalStressReduction` (`stressCount`) | integer count |
| **Panel silicon info** | &mdash; | `com.webos.service.panelcontroller/getOledCellInfo` / `getOledTconInfo` | Cell ID & TCON FPGA FW |

On older TVs, the interval file reading `24` means four hours, matching LG's documented
cumulative-viewing cycle — not twenty-four. It is expressed in the same 10-minute units as
the Luna counters it gets compared against, while `autoOffRsTime` alongside it is in
hours. Confirmed on a live TV: `autoOffRsTime` 3426 against a `panelUsageTime`
of 20576 (÷6 = 3429).

On webOS 9+ TVs, `autoOffRsInterval` is expressed directly in whole hours (`4`),
`autoJbInterval` reports `2000 ok`, and `panelcontroller/getPanelUsageTime` provides
the live usage counter in 10-minute units. Confirmed on an LG C2: `autoOffRsLastTime` 4767
against a `panelUsageTime` of 28614 (÷6 = 4769).

## Panel detection

Panel-lifecycle features are gated on panel type, detected once via
model name matching (`OLED...`), `/var/luna/preferences/paneltype_oled`, pnwash filesystem
records, or a `panelUsageTime` query that actually responds. On an LCD/QNED set they are
omitted from the dashboard and withheld from MQTT discovery, with retained discovery configs
cleared so they do not linger in Home Assistant as orphans. Reporting `0 hours` would read as a real
measurement.

## Deploying over ssh

Two things bite when moving off telnet, both because an inline `ssh` command
becomes the remote shell's own `argv`:

- **`pkill -f tvweb.js` kills the shell running it.** Its command line contains
  that path, so it matches itself. The bracket trick does not save you either,
  since the path appears again in the start command. Hence `tvwebctl`: inside a
  script file the shell's argv is just the script.
- **`setsid ... &` does not detach.** The child inherits the ssh session's stdin
  and dies when the connection closes — the server starts, publishes discovery,
  then vanishes. `start-stop-daemon -b -m` survives.

`rsync` ships with the Homebrew Channel but is broken on-device: it cannot load
`libcrypto.so.1.1`. Use `scp`, which works over the sftp subsystem.

## Upgrading in place

Five things decide how `tvwebctl update` works.

**The HTTP client is probed, not assumed.** Node 0.12's `https` has no CA bundle
worth trusting, so the download goes through curl or wget. The stock
`/usr/bin/curl` reaches GitHub on both TVs tested — 7.53.1 against OpenSSL
1.0.2p on webOS 4.4.3, 7.82.0 against OpenSSL 3.0.9 on webOS 9.2.2 — but that is
not something to assume of other firmware, and a client the owner installed can
be anywhere. Installed clients are tried before the stock one, each against the
real release endpoint until one returns usable JSON. A client that does that has
proved everything that matters. Certificate verification is never disabled: what
comes back runs as root on the next restart.

**The directory is updated in place, not swapped.** `/var/lib/tvweb` holds more
than code — `config.json`, `adblock_hosts`, the staged screen saver the boot hook
bind-mounts, `services_stopped` — and a wholesale swap has to carry every one of
them across or silently lose it. Replacing only the files the release ships
cannot lose state it never touches.

**Every file is renamed into place, never written over.** Busybox ash reads a
script as it executes, so overwriting `tvwebctl` corrupts the watchdog loop
already running out of it. A rename leaves that process on the old inode.

**The tarball is inflated by node, not by tar.** `zlib` is certainly present and
busybox's gzip support is not, and an inflate failure is how a truncated download
is caught — cheaper than trusting a content length. The unpacked `tvweb.js` then
has to declare the version that was asked for before anything is replaced.

**A client that cannot answer is not the same as a request that is refused.**
Treating every non-zero exit as "try the next client" reported a 404 from a
repository with no releases as `no HTTP client on this TV could reach GitHub -
install a current curl`, which would send someone off installing software they
already have. Both clients name the status on stderr (`server returned error:
HTTP/1.1 404`, `ERROR 404:`, `returned error: 404`) and both keep an exit code
for it — curl 22, wget 8 — so an HTTP answer of any kind ends the probe: the
transport has proved itself and only the request is wrong. The 403 wording stays
hedged, since a proxy or a captive portal returns that as readily as a spent
rate limit.

The upgrade runs in the server itself, with `tvwebctl update` invoking
`node tvweb.js --update` as a one-shot. One implementation serves the dashboard,
Home Assistant and the shell, and the shell path still works with the dashboard
switched off or the server not running. `--update` exits 3 when there is nothing
newer, which `tvwebctl` reads as "no restart needed" rather than as a failure.

## Fonts

The dashboard bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
[Manrope](https://github.com/sharanda/manrope) as variable fonts, both under the
SIL Open Font License, served by the TV so the page needs no internet access.
Licence texts ship alongside them in `server/assets/fonts/`.

---

## Consent flags are rebuilt from LG's agreement documents at boot

`/var/luna/preferences/eula` is a mirror. `com.webos.settingsservice` holds the
values under the `eulaStatus` key and regenerates the file, and its `eula.md5`
sidecar, at boot - so editing the file directly reverts. Flipping
`thirdPartySharingAllowed` in the file survived inspection, the dashboard and 75
seconds of runtime, then came back byte-identical after a reboot (md5
`85aca988...`, mtime set during boot).

Writing through the service works, but the flag alone does not survive a boot.

`eulaStatus` is derived from a second record: `eulaInfoNetwork`, LG's agreement
documents with an accepted flag on each. At boot the firmware rebuilds every
mapped flag from the accepted documents, so a flag written on its own is
overwritten by whatever its agreement still says. Reported on a C8 (webOS 4.4.0)
in [#61](https://github.com/rorygallagher2024/lg-webos-dashboard/issues/61).

**Both firmwares rebuild.** An earlier note here said a B8 on 4.4.3 did not, on
the strength of `cookiesAllowed` surviving a reboot. That flag is absent from
`eulaMappingList`, so the rebuild never touches it - the one flag that was
exempt, generalised to all of them. Measured properly on the same B8:

| Write | After a reboot |
| :--- | :--- |
| `thirdPartySharingAllowed` false, document left accepted | back to `true` |
| the same flag through the panel, withdrawing `S_ADG` | still `false` |

So a write has to move both records. Switching a flag on accepts the documents
it needs; switching it off withdraws those no remaining flag requires, and any
flag resting on one goes off with it. A document needed by a flag that cannot
be switched off is never withdrawn, which is what keeps Terms of Use in place.

Several flags share one document, so they can only be switched off together.
The panel names them before they are clicked.

`eulaInfoNetwork` also carries the document titles - `S_ADG` is the "Viewing
Information Agreement" - and is the only place on the TV that names them. The
file that caches it does not exist on webOS 9, so it is read from the service.

Two quirks. `getSystemSettings` answers for `eulaStatus` only when no `category`
is given - `general`, `option` and the rest return "There is no matched result
from DB". And the setter takes the whole `eulaStatus` object, so changing one
flag is a read-modify-write.

A flag that sticks still only records what the TV stored. It does not prove LG
honours it, and the value may be mirrored against the account server-side.

`returnValue: true` is the service accepting the call, not evidence it stored
anything - writing the file directly looks exactly as successful. Every write
from the panel is read back before it reports success, so a TV where the
setter is a no-op says so rather than showing a toggle that has not moved.

Which flags exist varies: a B8 on 4.4.3 has 21, a C2 on 9.2.2 has 23, including
`marketingOnAllowed`, `shoppingOnAllowed` and `takeOnAllowed`, and no
`allAllowed`. `eulaMappingList` differs too - `additional1Allowed` is in a group
on 4.4.3 and in none on 4.4.0. Nothing about the TV is hardcoded for that
reason: the mapping decides which flags the panel will write, and a TV that
publishes no mapping gets no toggles on undescribed flags at all.

## luna-send prints nothing without a tty

Over a non-interactive ssh command it returns an empty string and exit 0, which
reads as a call that succeeded silently. Use `ssh -tt`. Calls made by `tvweb.js`
on the TV itself are unaffected - this bites when testing by hand, and it is an
easy way to convince yourself a change worked when nothing ran.

## Shortcut button mapping is owned by LG's servers

Researched and built, then dropped before shipping: it cannot be made to work
from a cold boot. Kept here because the constraints are expensive to rediscover
and none of them are visible from the outside.

**Why it was dropped.** Every route needs the compositor to read a changed key
filter, and the only hook available runs too late. `startup.sh` invokes
`run-parts /var/lib/webosbrew/init.d` from the Homebrew Channel service, well
after `surface-manager` has started and read the stock file - measured on a C2,
the compositor was serving windows at 15s uptime and the hook ran at 35s. A
bind-mount applied then does nothing until the compositor restarts, and
restarting it mid-boot tears down the UI and fires a burst of system
notifications. So the choice is a disruptive restart on every boot, or buttons
that stay stock until something else restarts the compositor. Neither is worth
having.


The remote's streaming buttons (Netflix, Prime Video, Disney+ …) resolve through
`mapping_info` in the settings service, `category: "other"`, which
`/usr/lib/qml/KeyFilters/appLaunch.js` reads at compositor start. Writing it
works and persists, so it looks like the place to remap a button - but
`cb_getHotkeyInfo()` treats LG's cloud response as authoritative: it overwrites
the in-memory table and then writes that back over the settings key. Measured on
a C2 (webOS 9), a `rakutentv` remap read back correctly and then returned to the
stock `ui30` after a compositor restart, the payload shrinking 8319 to 7248
bytes as LG pushed its own list.

Two further details from that file:

* The subscription at `appLaunch.js:615` is registered *without*
  `"subscribe": true`, so even an unclobbered value is read only at compositor
  start. Any mapping change needs a `surface-manager` restart regardless.
* `isActive` on each entry marks the buttons the model and its remote actually
  have, which is the per-model list to offer and needs no hardcoded table. The
  button-to-key-constant pairs come out of `getPowerOnReason()` in the same
  file, so both follow the firmware rather than this repository.

The remap therefore catches the key earlier: `systemUi.js` runs before
`appLaunch.js`, so a `case WebOS.Key_webOS_<Name>:` added to
`handleSystemKeys()` that returns `KeyPolicy.Accepted` launches the chosen app
and the CP-hotkey handler never sees the press. `shortcut-key.sh` bind-mounts a
patched copy, rebuilt each time from a pristine original so cases cannot
compound, and refuses to mount anything `node --check` rejects - a key filter
that does not parse takes the compositor down with it. The mount does not
survive a reboot, so a power cycle is always the way back; the boot hook
re-applies it, before the compositor starts where it can, which saves a restart.

Two traps when working on it: validate the staged copy under a name ending
`.js`, since `node --check` refuses an unknown extension like `.tmp` and the
check then fails every time; and `/var/log/messages` timestamps are UTC while
`date` is local, which makes a fresh button press look an hour stale.

### webOS 4 differs in five ways, all of them load-bearing

Verified on an OLED65B8SLC. The feature works there, but nothing about it can be
assumed from the webOS 9 shape:

| | webOS 9 (C2) | webOS 4 (B8) |
| :--- | :--- | :--- |
| Key filters | `/usr/lib/qml/KeyFilters` | `/usr/lib/qt5/qml/KeyFilters` |
| Button named by | `powerOnReason = "netflix"` | `appId = "netflix"` |
| Button list | `mapping_info`, filtered on `isActive` | absent — settings returns "no matched result from DB" |
| Init | systemd, `systemctl restart --no-block` | upstart, `initctl restart` |
| `node --check` | present | absent (node 0.12) |

The missing `mapping_info` means there is no way to know which buttons the
remote physically has, so the list falls back to every button the firmware can
launch — three on the B8, one of them `ivi`, which a UK remote does not carry.
Assigning a button that is not there simply never fires, so the fallback is
offered with that said plainly rather than withheld.

Without `--check`, the staged file is validated by compiling it instead:
`new Function(src)` raises on a syntax error and never runs the body, which
matters because the body expects QML globals that do not exist in node.

The insertion point is the top of the `switch (key)` in `handleSystemKeys`,
not above a named case. On webOS 4 several stock cases are a fall-through group
— `Qt.Key_Super_L` and `Qt.Key_Menu` fall into `WebOS.Key_webOS_Recent` — and a
case placed inside one would capture the Home and Menu keys with it. The top of
the switch belongs to no group, and a case ending in `return` cannot be fallen
into.

## tvpower reboot does not reboot

`luna://com.webos.service.tvpower/power/reboot` accepts the request, validates
its parameters (omitting `reason` returns `errorCode -7`) and reports success -
but the kernel never restarts. Measured on an OLED65B8SLC running webOS 4.4.3:

| | uptime |
| :--- | :--- |
| before the call | 12810s |
| after (set was off the network ~65s) | 12871s |

It behaves like a standby transition. `/sbin/reboot` performs a real restart:
uptime reset to 60s, with services and the webosbrew boot hook all returning
cleanly. The reboot control therefore uses the kernel path, replying to the
client first because the process is about to go down with the system.

## The thermal sensor lags boot

`/proc/lg/pm/temperature` reads a literal `0` for roughly the first 80 seconds
after a restart - valid at 83s uptime on the test set, still `0` at 73s. That
is not a measurement, so it is reported as `null`, kept out of the history ring
buffer, and shown as a dash. Publishing it would put a false 0&deg;C spike into
Home Assistant's history on every reboot.

## Remote control keys and the Home launcher across webOS versions

The D-pad and navigation keys (`up: 103`, `down: 108`, `left: 105`, `right: 106`, `ok: 28`, `back: 412`) operate uniformly through `luna://com.webos.service.networkinput/test/sendKeyCode`, but the Home button has two fundamentally different architectures across webOS generations:

* **Modern webOS (webOS 6+, 2021+)**: The home screen was redesigned as a standalone full-screen application (`com.webos.app.home`). It does not respond to standard remote evdev key codes, but launches reliably via `com.webos.applicationManager/launch` with `{ id: 'com.webos.app.home' }`.
* **Legacy webOS (webOS 3–5, 2016–2020)**: `com.webos.app.home` does not exist as an installed application (returning `{ errorCode: -101, errorText: "not exist" }`). Instead, the Home launcher is an integrated system UI overlay ribbon (`superRibbon` inside Qt `surface-manager`).

### Why sendSpecialKey fails silently on webOS 3–5

Calling `com.webos.service.networkinput/sendSpecialKey` with `{"key": "HOME"}` returns `{ returnValue: true }`, but fails to bring up the Home launcher on screen.

In Qt's `KeyFilters/systemUi.js`, `Qt.Key_Super_L` (Linux keycode 125, `KEY_LEFTMETA`) implements a long-press discriminator:

```javascript
if (key === Qt.Key_Super_L) {
    if (pressed) {
        if (autoRepeat) return KeyPolicy.Accepted;
        global.prepareToGoHome();
        if (!longPressTimer.isRunning(key))
            longPressTimer.set(key, 1000, global.gotoRecents);
    } else {
        if (longPressTimer.isRunning(key)) {
            global.goHome();
            longPressTimer.cancel();
        }
    }
}
```

On key release, `global.goHome()` is called **only if** `longPressTimer.isRunning(key)` is true. `network-input-service`'s internal `UInputWriter::sendKeyPress` sends key press and key release back-to-back with 0ms delay. When both evdev events arrive in the same event tick, Qt processes them before the timer is active, so `goHome()` is never triggered.

### The dual-strategy solution

The server attempts to launch `com.webos.app.home` first. If that succeeds (webOS 6+), it returns immediately. If the launch returns `returnValue: false`, it falls back to direct event injection using `injectKey(125, cb, 100)`.

The 100ms hold duration between key-down and key-up gives Qt's event loop sufficient time to arm `longPressTimer`, ensuring `global.goHome()` fires on release (`LSM NL_HOME_SHOWN`) and toggles the native Home launcher ribbon on webOS 3–5.

## Older hardware capabilities (webOS 3.x and LCD models)

Testing against 2016 hardware (such as 43UH610V-ZB and 55UH6030-UC on webOS 3.4.3) highlights several differences between older LCD platforms and modern OLED sets:

* **OLED Protections & Metrics**: 2016 UH-series models use IPS LCD panels. Features such as Pixel Refresher, Screen Shift, Logo Luminance Dimming, GSR stress counts, and panel hours do not exist on LCD hardware. The server inspects the model name at startup, sets `capabilities.oled: false`, and hides the OLED Care tab and associated MQTT discovery entities.
* **SoC Temperature**: webOS 3.x kernels (Linux 3.10) do not expose `/proc/lg/pm/temperature`, `/sys/class/thermal`, or `hwmon`. The server detects the absence of the file, marks `capabilities.thermal: false`, withholds the Home Assistant entity, and displays `"NO THERMAL SENSOR"` rather than printing a fake 0&deg;C reading.
* **eMMC Flash Wear**: Older eMMC 5.0 controllers and Linux 3.10 lack the `/sys/block/mmcblk0/device/life_time` and `pre_eol_info` sysfs nodes. The server flags `capabilities.emmcWear: false` and prunes the flash wear and health cells from the Storage section.
* **Screen Off & Screen Saver**: Luna commands `com.webos.service.tvpower/power/turnOffScreen` and `turnOnScreenSaver` are designed for OLED panel protection without system standby. On LCD sets, the backlight and panel cannot be powered down independently of the main SoC, so these calls fail or are no-ops.
* **Startup Duration**: Older dual/quad-core Cortex-A9 chipsets paired with slower flash memory require significant time to complete boot initialization. The server's boot startup delay was tuned to 5s in v0.37.4, which provides sufficient margin for network interfaces and Luna routing daemons to settle without causing service crashes.

---

## The blocker's second tier takes LG's own platform with it

The blocklist is applied by bind-mounting a generated hosts file over
`/etc/hosts`, which is the only way to change it on a read-only rootfs - the
same technique webosbrew uses for `/etc/shadow` and `/etc/motd`. Verified
working: `getent hosts ad.lgsmartad.com` returns `0.0.0.0`.

Nine of the nineteen domains are ad, tracking and diagnostics hosts that
nothing on the TV needs. The other ten are **LG infrastructure rather than
advertising**, which is why they are a separate tier:

| Domain | What it actually serves |
| :--- | :--- |
| `ngfts.lge.com`, `aic-ngfts.lge.com` | Content and firmware delivery CDN |
| `lgtvsdp.com` (and `us.`/`gb.`/`eu.`) | Service platform behind the Content Store on webOS 4 |
| `nextlgsdp.com` (and `us.`/`gb.`/`eu.`) | The same on webOS 9 |

`com.webos.appInstallService` names the one its own set installs from:
`http://GB.lgtvsdp.com` on a B8, `http://GB.nextlgsdp.com` on a C2. The full
tier adds whatever that file says, so a firmware using neither is still covered.

Blocking them is a defensible choice, but it means **firmware updates and the
app store may stop working** on that tier. Anyone who turns it on and later
finds the Content Store broken will not connect the two events unless told, so
it is stated at the control in the UI as well as here.

## Entity state must come from the TV, not from the command

Entities derive state from the telemetry payload via a `value_template`, so
they re-assert the truth on every tick whatever changed it - dashboard, remote,
the TV's own menus, or Home Assistant.

The display panel switch originally published only when a command arrived over
MQTT, plus a retained `ON` on every connect. Blanking the panel from the
dashboard left Home Assistant showing it on indefinitely. It is now reconciled
against `powerState` each telemetry publish.

So: prefer `state_topic: telemetryTopic` with a template. An entity on its own
topic must be republished from real state every tick, or it is a guess that
holds until someone notices.

`scripts/check-entities.py` resolves every entity's `value_json` paths against a
live `/api/stats`. A renamed field otherwise leaves an entity at `unknown` with
no error anywhere.

---

## Rotating a log the server is holding open

`/var/lib` is flash and nothing trimmed `tvweb.log`, so a broker the TV could
not reach appended a line every five seconds - the retry interval - for as long
as the outage lasted. Two changes: repeated MQTT connection errors are counted
and reported once rather than logged individually, and the watchdog in
`tvwebctl` trims the file at 256k.

The trim keeps one previous generation and truncates in place rather than
renaming. Renaming does not work here: the server writes to a descriptor it
already holds, so it follows the file under its new name and the fresh one
stays empty. Truncating in place only works if that descriptor was opened
`O_APPEND`, which is why `start_app` redirects with `>>` and not `>`. Without
it the server keeps its own offset and carries on writing past the old end,
leaving a sparse file that still reports the size the trim just reclaimed -
measured at 19MB apparent against 3MB allocated, which would send the watchdog
into rotating it on every pass.

---

## The checks

`scripts/` holds five static checks. Four need nothing but the repository and
run in CI alongside `shellcheck`; `check-entities.py` needs a live
`/api/stats`, so it is run by hand against the TV.

| Check | What it catches |
| :--- | :--- |
| `check-es5.py` | An ES6 construct in `tvweb.js`. Node 0.12 treats one as a parse error, so the server never starts and logs nothing. |
| `check-ui-ids.py` | An id the dashboard reaches for that no element defines. |
| `check-screensavers.py` | QML newer than the `import QtQuick` line it declares. |
| `check-drift.py` | A documented entity count the code has moved past, and an asset `deploy.sh` would never install. |
| `check-entities.py` | An entity template naming a field the telemetry no longer has. |

`check-es5.py` blanks strings, comments and regex literals before scanning, and
checks syntax only: an ES6 library call parses and fails at the call, which the
log shows, while a parse error leaves no process to log anything.

---

## In-place updater and binary probing

The in-place updater (`server/lib/updater.js`) downloads the release tarball from GitHub directly onto the TV and unpacks it over `/var/lib/tvweb/` without needing a computer or `deploy.sh`.

### Download Client Probing
The download requires `curl` or `wget` on the TV. LG's stock `/usr/bin/curl` reaches GitHub on tested TVs, but third-party tools or stripped setups might place modern clients in non-standard paths. To ensure reliable downloads across webOS generations, the updater probes executable binaries in prioritized order:

1. `/media/developer/bin` (Homebrew Channel package directory)
2. `/usr/local/bin`
3. `/opt/bin` and `/opt/usr/bin` (Optware / Entware)
4. `/var/lib/webosbrew/bin`
5. `/home/root/bin`
6. `/usr/bin` and `/bin` (stock system binaries)

A custom client path can also be configured in `config.json` via `"update": { "client": "/path/to/curl" }`.

### Safe In-Place Staging & Rollback
1. **Extraction & Validation**: The tarball is decompressed via Node's `zlib.gunzipSync` and unpacked into `/var/lib/tvweb/.update/`. It validates that the downloaded package contains a valid `server/tvweb.js` declaring the expected release version.
2. **Non-Destructive Upgrade**: Files are copied over `/var/lib/tvweb/`. `config.json`, the ad blocker's hosts file (`adblock_hosts`), staged screensavers, and stopped service lists are strictly preserved.
3. **Rollback Backup**: A complete copy of the replaced version is retained in `/var/lib/tvweb/.previous/`. Running `tvwebctl rollback` (or manually copying `.previous/.` back to `/var/lib/tvweb/`) restores the previous version without redeploying.

---

## Home Screen Tile Hiding & Cold Boot Sequence

Home screen bloatware tile hiding allows built-in or preloaded system apps (which lack uninstallation mechanisms on the Luna bus) to be removed from the launcher view without modifying the read-only rootfs (`/`).

### Non-Destructive Manifest Bind-Mounts
1. **Manifest Overrides**: For each hidden app ID, `server/lib/apps.js` stages a modified `appinfo.json` in `/var/lib/tvweb/appinfo-overrides/<id>.json` with `"visible": false`.
2. **Multi-Base Probing**: Overrides are bind-mounted over every discovered location for the target app manifest (prioritizing `/media/system/apps/usr/palm/applications` for OTA-updated system apps, followed by `/usr/palm/applications` and flash mounts `/mnt/otncabi` / `/mnt/otycabi`).
3. **SAM Refresh**: SAM (Surface Application Manager) caches `appinfo.json` once per launch point. To force an immediate update, `apps.js` signals SAM (`killall -9 LunaExecutable` and `systemctl kill -s 9 sam.service` on systemd / `initctl restart sam` on Upstart). SAM restarts in sub-seconds and drops the hidden tiles from the launcher.

### Cold Boot vs. Quick Start+ (Standby)
- **Normal Usage (Quick Start+)**: LG webOS defaults to Quick Start+ (Active Standby / Suspend-to-RAM). When the TV is powered off and on with the remote, the Linux kernel, active bind-mounts, and SAM remain running in memory. The overrides remain intact, and hidden tiles never appear.
- **Cold Boot (Full Reboot / Power Loss)**: On a true cold boot, webOS boots from an early checkpoint/snapshot (CRIU), displaying the Home screen (`com.webos.app.home`) before late userland root hooks run. The Home screen briefly shows the stock tiles for a few seconds until `devmode.service` invokes `/var/lib/webosbrew/startup.sh` &rarr; `run-parts /var/lib/webosbrew/init.d/50-tvweb`.
- `50-tvweb` reapplies the bind-mounts from `/var/lib/tvweb/hidden_apps` in ~50ms and respawns SAM, at which point the Home screen drops the tiles from view. This brief appearance on cold boot is architectural to webOS's read-only root partition: root hooks run safely in user space without modifying rootfs systemd units.

