# What the dashboard changes on the TV

Nothing on the read-only root filesystem is written. Everything below other
than the server's own files happens only when the owner switches it on, and the
riskier controls ask for confirmation in the dashboard first.

## Files and startup

| Change | Where | Undone by |
| :----- | :---- | :-------- |
| The server, its config and state | `/var/lib/tvweb` | Uninstalling |
| Boot hook that starts the server | `/var/lib/webosbrew/init.d/50-tvweb` | Uninstalling |
| Boot log | `/var/lib/webosbrew/tvweb-boot.log`, kept under 32 KB | Uninstalling |
| Boot hook that holds switched-off services down | `/var/lib/webosbrew/init.d/20-tvweb-services`, only once a service is switched off | Switching the services back on, or uninstalling |
| Home-screen tile | A developer app, added by `deploy.sh` on a first install | Removing it from the Server tab |

See [Uninstalling](../README.md#uninstalling) to remove them.

## Features that change how the TV runs

These last until a reboot and are put back by the boot hook, so they end with
the first reboot after uninstalling.

| Feature | What it does | Undone by |
| :------ | :----------- | :-------- |
| Ad blocker | Bind-mounts a replacement `/etc/hosts` | Switching it off |
| Hidden home-screen tiles | Bind-mounts edited `appinfo.json` files, then restarts the app manager so the home screen rereads them | Switching tile hiding off |
| Switched-off background services | Stops them and masks their systemd units under `/run` | Switching them back on |
| Replacement screen saver | Bind-mounts over the built-in screen saver app; restarts the app manager at boot when the replacement is a different app type | Choosing the stock screen saver |

## Changes that stay

These go through LG's own services and persist like any change made in the TV's
menus. Uninstalling the dashboard leaves them as they are.

| Change | Note |
| :----- | :--- |
| Uninstalling an app | Permanent; reinstall it from the LG Content Store |
| Picture mode, energy saving, sound output, Quick Start+, sleep timer | Ordinary TV settings |
| Screen Shift, Logo Luminance Adjustment | OLED panel settings in the TV's own menus |
| Global Stress Reduction and Temporal Peak Control | OLED burn-in protections. Switching one off asks for confirmation, and neither is exposed to Home Assistant. Not switched back on by uninstalling |
| Service menu lock | Unlocking asks for confirmation. Not locked again by uninstalling |
| Privacy consents, advertising ID reset, advertising cookies | The same agreements as in the TV's settings |

## Network

The dashboard listens on port 8080, on the whole network unless it is limited
to the TV itself in `config.json` or from Settings on the TV. While a phone is being used to enter Home Assistant details,
port 8081 answers a one-time code for up to ten minutes. The server connects out
only to the configured MQTT broker and, when update checks are switched on, to
GitHub's releases API. Update checks are off by default.
