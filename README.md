# LG webOS TV Dashboard & Home Assistant Bridge

A server that runs **on** a rooted LG webOS TV. It serves a live dashboard to
any browser on the network, and will optionally bridge the TV into Home
Assistant over MQTT as a single auto-discovered device.

The dashboard needs nothing but the TV. Home Assistant control over MQTT is
optional, and set up in [step 4](#4-home-assistant--mqtt-optional).

### Compatibility at a glance

* **webOS**: 3.4 through 25 (2016–2025 models)
* **Panels**: OLED (full panel wear telemetry and burn-in controls) and LCD (core dashboard, controls, and telemetry; OLED Care tab hides automatically)
* **Access**: Rooted via [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) (telnet) or SSH &mdash; no external dependencies or internet access needed on the TV
* **Tested hardware**: 12 verified models so far (B7, B8, C8, C9, C1, C2, B4, G4, C5, UH6030) &mdash; [see full table](#tested-on)

[Overview](#what-its-for) • [Screenshots](#web-dashboard) • [Features](#core-features) • [Requirements](#requirements) • [Installation](#3-install-the-dashboard) • [Home Assistant](#4-home-assistant--mqtt-optional) • [Tested Sets](#tested-on) • [Security](#security)

---

## What it's for

1. **[Controlling the TV without the cloud](#remote-control).** A D-pad to navigate the TV itself, volume, mute, media playback keys (play, pause, stop, skip), app launcher, picture presets, sound output routing, power and reboot.

2. **[Seeing what the TV collects, and switching it off](#privacy-and-data-collection).** Whether LG's
   content-recognition engine is running and sampling your screen, your
   advertising identifier and whether ad tracking is limited, and every data
   agreement recorded on the set with most of them switchable from the
   dashboard. Includes an on-TV blocker for LG's ad and telemetry
   endpoints, and a switch for the two diagnostics services that upload to LG.

3. **[Replacing the screen saver](#screen-savers).** A clock, a starfield, fireworks, or the
   TV's own readings, each dim or bright, in place of LG's.

4. **[Integrating the TV into Home Assistant](#home-assistant-bridge).** Optional, over MQTT: the set
   arrives as a single auto-discovered device &mdash; no YAML, no LG
   account &mdash; so the TV can be automated and its telemetry recorded
   alongside everything else in the house.
   [Step 4](#4-home-assistant--mqtt-optional) explains what MQTT is.

5. **[Seeing what the TV is actually doing](#telemetry-and-diagnostics).** SoC temperature, per-core CPU
   load, memory, swap, current draw, Wi-Fi signal and throughput.

6. **[Observing OLED panel wear](#oled-wear-and-burn-in-protection).** Cumulative panel hours, compensation cycle
   progress, Pixel Refresher countdown with scheduling, completed cycle counters
   and failure alerts.

7. **[Controlling the OLED burn-in protections](#oled-wear-and-burn-in-protection).** What each one does and a switch
   for it: screen shift and logo dimming on any OLED, and on sets that expose
   them, ASBL and Global Stress Reduction &mdash; the two normally reachable only
   from the TV's service menu, with a service remote and a PIN.

8. **[Opening the service menu, and unlocking it where it is locked](#service-menu-access).** LG's own
   engineering menu, put on the TV screen from a browser &mdash; no service
   remote. Newer firmware shows a cut-down version of it until it is unlocked,
   which the dashboard can do as well.

---

## Web dashboard

<p align="center">
  <a href="docs/screenshots/dashboard.png"><img src="docs/screenshots/dashboard.png" alt="System tab: SoC temperature, system readouts, storage and HDMI ports, dark theme (OLED65B8SLC)" width="440"></a>
  &nbsp;
  <a href="docs/screenshots/dashboard-light.png"><img src="docs/screenshots/dashboard-light.png" alt="Control tab: panel, source, volume, playback, sleep timer, front lights and power, light theme (OLED65B8SLC)" width="440"></a>
</p>

## Home Assistant (auto-discovered device via MQTT)

The TV arrives over MQTT Discovery as a single unified device
<p align="center">
  <a href="https://github.com/user-attachments/assets/1d76b1a2-68d9-42a4-a497-b107d706b235"><img width="800" alt="Home Assistant MQTT entities" src="https://github.com/user-attachments/assets/1d76b1a2-68d9-42a4-a497-b107d706b235" /></a>
</p>

A custom Home Assistant dashboard for an LG TV:
<p align="center">
  <a href="https://github.com/user-attachments/assets/737b3106-e8a4-4c6b-ba96-b0bad130b600"><img width="800" alt="Custom dashboard leveraging MQTT data" src="https://github.com/user-attachments/assets/737b3106-e8a4-4c6b-ba96-b0bad130b600" /></a>
</p>

---

## Core features

Each has a tab of its own in the dashboard, and a deep link to it. OLED Care
appears on OLED sets only. Fonts and assets are served by the TV, so the page
works with no internet access, and a high-contrast light theme with dark text
sits alongside the default true-black OLED one &mdash; masthead toggle (☾ / ☀)
or `/?theme=light`.

### Remote control

The **Control** tab, `/?tab=control`. Drives the set from a browser, including
the things the remote does not do easily.

* A D-pad &mdash; arrows, OK, Back and Home &mdash; to navigate the TV's own
  interface.
* Volume, mute, input select, and media playback &mdash; play, pause, stop,
  skip &mdash; through native remote key injection.
* App launching, picture presets and sound output routing. The presets on offer
  are the ones the TV will accept for whatever is playing: a Dolby Vision source
  has its own set.
* Screen blanking, sleep timer, standby LED, on-screen notifications, and power
  and restart &mdash; from here or from Home Assistant.

### Telemetry and diagnostics

The **System** tab, `/?tab=system`. What the set is doing and what it is made
of, most of which is absent from its own settings menu.

* SoC temperature and current draw, CPU and per-core load, GPU clock, memory and
  swap, Wi-Fi RSSI and network throughput.
* eMMC flash wear with JEDEC health translation, and free space on the app
  partition.
* HDMI link state per port straight off the receiver &mdash; resolution, refresh
  rate, colour depth, pixel clock &mdash; and, where `/proc/lg/hdmi20` exists,
  HDMI 2.1 diagnostics: link rate, chroma format, HDCP version, cable error
  counter, ALLM, VRR, QMS and colorimetry.
* Dolby Vision / HDR / SDR detection, picture mode, OLED light level, the raw
  HDMI signal (`3840x2160 @ 120Hz`), audio output routing, and the running app
  with friendly input names (`Apple TV (HDMI2)`).
* Magic Remote battery and model; webOS and firmware version, SoC architecture,
  OLED cell ID and TCON firmware where the platform exposes them.
* On demand: what is resident in memory, and which processes are using the
  processor right now &mdash; measured over a short window rather than read from
  the lifetime average `ps` reports.

<p align="center">
  <img width="432" alt="System tab: processor, memory, swap, network and current draw readouts" src="https://github.com/user-attachments/assets/2e6cfe5a-c905-426e-8b4d-8f52d4f31c11" />
</p>

### Privacy and data collection

The **Privacy** tab, `/?tab=privacy`. Reports what the TV is doing rather than
repeating its settings menu: whether the content-recognition engine is running
and sampling frames, the set's advertising identifier and whether ad tracking
is limited, every data agreement recorded on the set, and which of LG's
collection services are alive &mdash; the two the service bus starts on demand
are marked as such, and the two upstart supervises can be switched off for
good.

Most of those agreements can be switched off from here, and the advertising ID
can be reset and its cookies cleared. The TV keeps two records &mdash; the
agreements, and the flags derived from them &mdash; and a change writes both, so
it survives a reboot on firmware that rebuilds the flags at boot. Some
agreements cover several flags, and the panel names the ones that move together
before anything is clicked. Acceptance of the terms themselves is left to the
TV's own menus.

The ad & telemetry blocker blackholes LG's tracking, ad and ACR endpoints on the
set itself, by bind-mounting a hosts table over `/etc/hosts`, and is restored on
boot. Two tiers: *ads & telemetry* blocks the nine ad and diagnostics hosts and
leaves LG's service platform reachable; *everything* adds the ten that carry the
Content Store and firmware delivery, so on that tier the app store and updates
may stop working. The store server differs by platform
&mdash; `com.webos.appInstallService` installs from `lgtvsdp.com` on webOS 4 and
`nextlgsdp.com` on webOS 9 &mdash; and both are in that tier.

<p align="center">
  <a href="docs/screenshots/privacy.png"><img src="docs/screenshots/privacy.png" alt="Privacy tab: ad and telemetry blocker, advertising identifier, the data collection agreements grouped by subject with toggles, and what is running now" width="700"></a>
</p>

### OLED wear and burn-in protection

The **OLED Care** tab, `/?tab=oledcare`, on OLED sets. The panel's own wear
figures beside what each burn-in protection does and a switch for it.

* Cumulative panel hours, panel maintenance and Pixel Refresher countdowns with
  scheduling, completed cycle counters and failure alerts.
* Screen shift and logo dimming on any OLED.
* Temporal peak control (ASBL) and global stress reduction, on webOS 4 and
  webOS 9 alike &mdash; the two normally reachable only from the service menu,
  with a service remote and a PIN, and carrying a warning to match.

<p align="center">
  <a href="docs/screenshots/oledcare.png"><img src="docs/screenshots/oledcare.png" alt="OLED Care tab: screen shift, logo dimming, temporal peak control and global stress reduction, each described, with switches and a warranty warning" width="700"></a>
</p>

<p align="center">
  <img width="429" alt="Panel life: total power-on hours, panel maintenance and Pixel Refresher countdowns" src="https://github.com/user-attachments/assets/825ef48d-9560-474c-9d3e-7feb045724b5" />
</p>

### Service menu access

The **Service menu** tab, `/?tab=servicemenu`. Opens LG's engineering menu on
the TV &mdash; EZ Adjust or In Start &mdash; without a service remote; the TV
still asks for its PIN. Newer firmware shows a cut-down version until it is
unlocked, and the dashboard can unlock it: the TV has to be switched off and on
again before that takes effect. Sets old enough not to lock it say so.

> [!WARNING]
> The service menu provides low-level hardware and calibration control. Changing unfamiliar values in EZ Adjust or In Start can cause permanent display corruption or render the set unbootable.

<p align="center">
  <a href="docs/screenshots/servicemenu.png"><img src="docs/screenshots/servicemenu.png" alt="Service menu tab: unlock state with a power-cycle note, buttons to open EZ Adjust or In Start, and a warning about what the menu can change" width="700"></a>
</p>

### Screen savers

The **Screensaver** tab, `/?tab=screensaver`. Four in place of LG's: a clock, a
starfield, fireworks, and one showing the set's own panel hours and refresher
countdown. Each draws dim or bright, and all of them move so nothing marks the
panel. A firmware update restores the LG default.

<p align="center">
  <a href="docs/screenshots/screensaver.png"><img src="docs/screenshots/screensaver.png" alt="Screensaver tab: LG default, Clock, Starfield, Fireworks and Panel vitals, with a dim and bright toggle" width="700"></a>
</p>

<p align="center">
  <a href="docs/screenshots/screensaver-starfield.png"><img src="docs/screenshots/screensaver-starfield.png" alt="Starscape screen saver on OLED: drifting stars and meteor with ion trail" width="700"></a>
</p>

### Home Assistant bridge

The **MQTT** tab, `/?tab=mqtt`. Publishes the TV to an MQTT broker, where it
arrives in Home Assistant as a single auto-discovered device. The tab
holds the broker address, credentials, topic prefix and device identity, with
the bridge's connection state and last publish time beside them.
[Step 4](#4-home-assistant--mqtt-optional) covers the setup.

### Server updates

The **Server** tab, `/?tab=server`. The installed version, whether a newer
release is out, and buttons to install it or roll back to the version before.
**Check daily** looks on its own and lets Home Assistant offer the update.
[Updating](#updating) covers installs from before the tab existed.

## Requirements

* A rooted LG webOS TV ([Root tool here](https://github.com/throwaway96/dejavuln-autoroot/)) with the
  [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
* Nothing else on the TV for the dashboard.
* A computer on the same network to install from: a Mac, a Linux machine, or
  a Windows PC with [Git for Windows](https://git-scm.com/download/win), which
  adds the Git Bash window the install runs in. Nothing else needs installing,
  and the TV does not need internet access.
* An MQTT broker on the network, and usually Home Assistant, only if the
  bridge in [step 4](#4-home-assistant--mqtt-optional) is wanted.

### Tested on

Tested across the following sets so far. The Luna
service names and `/proc/lg` paths this relies on may differ across webOS
versions and panel types.

| Model | webOS | Firmware | Panel | Notes |
| :--- | :--- | :--- | :--- | :--- |
| OLED65B8SLC | 4.4.3 | 05.50.70 | OLED | Development set |
| OLED65C8PUA | 4.4.0 | 05.50.15 | OLED | No `getAdid` on this firmware |
| OLED65C9AUA | 4.9.x (4.5+) | 05.50.00 | OLED | |
| OLED55C9PLA | 4.9.0 | 05.30.40 | OLED | Working fine |
| OLED55C1PUB | 6.x (6.3+) | 03.53.45 | OLED | SSH install and MQTT bridge confirmed |
| 55UH6030-UC | 3.4.3 | &mdash; | LCD | |
| OLED55G42LW | 24 | 33.31.68 | OLED | Rooted with slopbro, not the Homebrew Channel |
| OLED42C24LA | 9.2.2 (22+) | 23.25.55 | OLED | Rooted with jsbro-autoroot |
| OLED65B7V-Z | 3.9.3 | 06.10.65 | OLED | No SoC temperature or eMMC wear readings |
| OLED55B46LA | 24 (9.24.8) | 23.23.30 | OLED | Installed over telnet |
| OLED55C17LB | 6.x | &mdash; | OLED | HDMI 2.1 diagnostics and remote battery reporting |
| OLED48C55LA | 25 (10.3.1) | 33.31.68 | OLED | Installed over telnet; in-app update to 0.37.2 confirmed |

**If you run it on anything else, please open an issue whether it's working or not**
Include your model, webOS version and
`/var/lib/tvweb/tvweb.log` and I will add a row.

---

## 1. Get the files

Download the project onto a computer on the same network as the TV. On
Windows, run these in a Git Bash window, which Git for Windows adds to the
Start menu:

```bash
git clone https://github.com/rorygallagher2024/lg-webos-dashboard.git
cd lg-webos-dashboard/server
```

## 2. Access

Nothing to set up: the install uses SSH if the TV has it, and the Homebrew
Channel's telnet if not.

> [!TIP]
> Telnet leaves an unauthenticated root shell open on your local network. [Moving from telnet to SSH](docs/SECURITY.md#moving-from-telnet-to-ssh) takes about five minutes and is strongly recommended.

## 3. Install the dashboard

Find the TV's address under Settings &rarr; Network on the TV, or in the
router's list of devices. Then, from the `server/` directory in your terminal:

```bash
./deploy.sh <tv-ip>
```

For example, `./deploy.sh 192.168.1.50`. It takes about ten seconds and finishes
by checking that the dashboard answers. When it says `done`, open
**`http://<tv-ip>:8080/`** in a browser. If anything goes wrong, it stops and
says why.

The server starts again by itself whenever the TV restarts. To try it without
that, add `--no-persist`, and it runs only until the TV next restarts. Setting
the router to always give the TV the same address saves looking it up again.

No configuration is needed for this part. Without a config file the dashboard
runs on port 8080, the controls are live, MQTT is off, and power off / reboot
are disabled. Nothing is sent anywhere: the server talks to the TV and to
whoever opens the page, and reaches the internet only to look for a new release -
when the dashboard's Server tab is opened, or daily if
[checking automatically](#checking-automatically) is switched on.

That is a complete install &mdash; step 4 is optional.

### If something does not come up

* **Nothing on port 8080.** On the TV, `/var/lib/tvweb/tvwebctl status` says
  whether the server is running and `/var/lib/tvweb/tvweb.log` says why it is
  not.
* **Panel hours and OLED Care missing on an OLED set**, or showing on an LCD
  one. Panel detection went the wrong way: set `"panel": "oled"` or
  `"panel": "lcd"` in `server/config.json` before a first deploy, or in
  `/var/lib/tvweb/config.json` on a TV that already has one.

## 4. Home Assistant & MQTT (optional)

### What these are

**Home Assistant** is open-source home automation software that runs on the
user's own hardware &mdash; a Raspberry Pi, a NUC, a container on a NAS. It
gathers devices from different vendors into one place and automates them. It is
not a service, and nothing here talks to a company's cloud.

**MQTT** is a lightweight messaging protocol. Something publishes a message to a
named topic, and anything subscribed to that topic receives it. It needs a
**broker** &mdash; a small server that relays those messages between publishers
and subscribers. [Mosquitto](https://mosquitto.org/) is the usual one, and Home
Assistant ships it as a one-click add-on.

This project publishes the TV's telemetry to a broker, and describes its own
entities using the **MQTT Discovery** convention. Home Assistant reads that
description and creates the device with all its sensors and controls by itself.
There is no YAML to write.

The bridge needs a broker reachable on the network. Home Assistant is the usual
reason to run one, but not a requirement &mdash; see
[Using MQTT without Home Assistant](#using-mqtt-without-home-assistant).

### Setting it up from the dashboard

Open the dashboard, then the **MQTT** tab. Fill in the
broker address and credentials, switch **MQTT bridge** on, and save. The server
writes `config.json` on the TV and restarts itself; the page reconnects on its
own after a few seconds.

Nothing else is needed. Home Assistant picks up the device within a few seconds
of the bridge connecting.

<p align="center">
  <a href="docs/screenshots/mqtt.png"><img src="docs/screenshots/mqtt.png" alt="MQTT tab: bridge status and switch beside the broker and device fields, with the entity categories published to Home Assistant" width="700"></a>
</p>

The panel reports whether the bridge is connected to the broker and how long ago
it last published, so a wrong address or a rejected password shows up there
rather than in the log on the TV.

### Setting it up from a config file

Equivalent to the above, and the better route for installing several TVs from
one machine or for keeping the settings under version control.

From `server/`, where step 1 left off:

```bash
cp ../config.example.json config.json
```

Set the broker under `mqtt` and set `enabled` to `true`, then run
`./deploy.sh <tv-ip>` again. Leaving `device.name` and `device.model`
empty makes the TV report its own model and firmware at runtime.

`deploy.sh` only installs this file if the TV does not already have one, so it
will not overwrite settings saved from the dashboard. To replace an existing
config, edit it through the dashboard or remove `/var/lib/tvweb/config.json`
first.

### Which settings live where

The dashboard can change the broker, credentials, topic prefix and device
identity &mdash; the things that decide *where* telemetry goes.

`port`, `host`, `allowControl`, `allowPower` and `token` are file-only. They
decide *who can reach the server at all*, and a web UI able to widen its own
exposure would defeat the point of setting them. Edit those in `config.json`
and redeploy, or edit `/var/lib/tvweb/config.json` on the TV and restart.

`allowPower` ships disabled, because there is no authentication unless `token`
is set &mdash; a fresh install should not expose "turn the TV off" to the whole
network. Enable it deliberately.

> [!NOTE]
> Give the TV its own MQTT user with a restricted topic ACL rather than reusing your main Home Assistant credentials. See [docs/SECURITY.md](docs/SECURITY.md).

### Using MQTT without Home Assistant

The bridge is a plain MQTT publisher, so anything that speaks MQTT can read it.
Telemetry is published as JSON to `<topicPrefix>/telemetry`, availability to
`<topicPrefix>/status`, and commands are accepted on `<topicPrefix>/command/*`.

```bash
mosquitto_sub -h <broker> -t 'lgtv/#' -v
```

Node-RED, Telegraf into InfluxDB, or a script subscribing to that topic all work
the same way. The Discovery messages are simply ignored by anything that is not
Home Assistant.

### Multiple TVs

Each TV on the same broker needs a unique `topicPrefix` and `device.id`,
otherwise they overwrite each other's state and disconnect each other. Both are
editable from each TV's own dashboard.

For the config-file route, `deploy.sh` checks for `server/config.<tv-ip>.json`
before falling back to `server/config.json`, which keeps per-TV settings from
being flattened by a shared file.

### Running one half without the other

| | `web.enabled` | `mqtt.enabled` |
| :--- | :--- | :--- |
| Dashboard and Home Assistant | `true` | `true` |
| Dashboard only *(default)* | `true` | `false` |
| Home Assistant only | `false` | `true` |

With the dashboard disabled the server is an MQTT bridge with no web interface,
which is the safer shape if everything is driven from Home Assistant &mdash; the
dashboard is an unauthenticated control endpoint unless `token` is set. Note
that this also removes the settings UI, so an MQTT-only install is configured by
file. With both disabled the server exits rather than idling.

See [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) for the entity list and
example automations.

## Managing it

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl status    # start | stop | restart | status
```

### Updating

How depends on the install. One with a **Server** tab in its dashboard updates
itself; an older one is updated by deploying again, after which it has the tab.

**With the Server tab.** Opening it looks for a newer release, and **Check now**
looks again. **Install** puts it on and restarts the server, and **Roll back**
returns to the version it replaced. Home Assistant offers the same install while the
[daily check](#checking-automatically) is on. Over ssh:

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl update           # install the latest release
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl update --check   # report without installing
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl rollback         # put the previous version back
```

**Without it, or for something unreleased,** pull the latest code into the clone
from [step 1](#1-get-the-files) and deploy again, with the flags used the first
time:

```bash
cd lg-webos-dashboard/server
git pull
./deploy.sh <tv-ip>
```

Only the server's own files are replaced: the TV keeps its settings, ad blocker,
screen saver and stopped services.

An in-place upgrade downloads the release tarball, replaces the files the
release ships and restarts. `config.json`, the ad blocker's hosts file, the
staged screen saver and the list of stopped LG services are left alone; the
replaced version stays in `/var/lib/tvweb/.previous` for `tvwebctl rollback`.
The boot hook is refreshed only where one is already installed.

The download goes through curl or wget on the TV. The TV's own `/usr/bin/curl`
reaches GitHub on the sets tested; where it cannot, the check says so and nothing
else changes, and installing a current curl or wget fixes it. An installed client
is tried first: the probe looks in the Homebrew Channel's own
`/media/developer/bin`, then `/usr/local/bin`, `/opt/bin`, `/opt/usr/bin`,
`/var/lib/webosbrew/bin` and `/home/root/bin`. Point
`"update": { "client": "/path/to/curl" }` at one that lives somewhere else.

`.previous` is a complete copy of the version that was replaced, so getting back
does not depend on the installed `tvwebctl` having a `rollback` command:

```bash
ssh root@<tv-ip>
/var/lib/tvweb/tvwebctl stop
cp -r /var/lib/tvweb/.previous/. /var/lib/tvweb/
/var/lib/tvweb/tvwebctl start
```

### Checking automatically

Off by default, because it reaches off the LAN without anyone asking.
**Check daily** in the Server tab switches it on, as does `config.json`:

```json
{ "update": { "check": true, "intervalHours": 24 } }
```

With it on, the server asks GitHub for the latest release once a day, the
dashboard footer shows a newer version next to the installed one, and Home
Assistant gets the update entity. The request says nothing about the TV beyond
the address any HTTP request reveals.

## Uninstalling

```bash
ssh root@<tv-ip>
/var/lib/tvweb/tvwebctl stop
rm -rf /var/lib/tvweb
rm -f /var/lib/webosbrew/init.d/50-tvweb*
```

Nothing on the TV's read-only rootfs is ever modified.

---

## Security

The dashboard has **no authentication by default** and binds to `0.0.0.0`, so
anyone who can reach the port can use every enabled control. On a home LAN that
is usually the point but you can set `"token": "something-long"` in
`config.json` if you want it gated, and never port-forward it. If you only use
Home Assistant, `"web": { "enabled": false }` removes the endpoint entirely.

The MQTT settings panel is part of that surface: on a default install, anyone
who can reach the port can change the broker the TV publishes to, and so
redirect its telemetry. It is gated by `token` and by `allowControl` like the
rest of the controls, and it cannot change `port`, `host`, `allowControl`,
`allowPower` or `token` themselves &mdash; those stay file-only so the UI cannot
widen its own exposure. The stored broker password is never sent to the browser.

Setting a token affects the dashboard only. **Home Assistant is unaffected**,
since MQTT is a separate channel.

Full detail, including the MQTT ACL guidance and optional TLS, is in
[docs/SECURITY.md](docs/SECURITY.md).

## Documentation

* [docs/SECURITY.md](docs/SECURITY.md) &mdash; threat model, SSH migration, MQTT hardening
* [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) &mdash; the entity reference, universal media player, example automations
* [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) &mdash; architecture, `/proc/lg` reference, platform quirks

---

## Disclaimer

**Use this software at your own risk.**

- **Root access and hardware.** This runs custom software with `root`
  privileges on an embedded TV OS. It is designed to be lightweight and to
  leave the read-only rootfs untouched, but the authors accept **no
  responsibility** for damage, bootloops, bricked devices, voided warranties,
  data loss or OLED panel issues.
- **Power and control commands.** Reboot, power off, screen blanking and Pixel
  Refresher scheduling issue low-level `luna-send` calls. Understand what each
  does before using it.
- **Trademarks.** An independent, unofficial community project, not affiliated
  with or endorsed by LG Electronics. webOS is a trademark of LG Electronics.
- **Fonts.** Bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
  [Manrope](https://github.com/sharanda/manrope) under the
  [SIL Open Font License 1.1](https://openfontlicense.org/); licence texts ship
  in `server/assets/fonts/`.

## License

MIT. See [LICENSE](LICENSE).
