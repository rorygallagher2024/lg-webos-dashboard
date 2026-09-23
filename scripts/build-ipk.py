#!/usr/bin/env python3
"""
Build the app the Homebrew Channel installs: an .ipk carrying the launch page
and, under payload/, the server itself, plus the manifest that the Homebrew
Channel's repository points at.

The package is made by LG's own packager, ares-package from @webos-tools/cli:
the repository's checks reject packages that lack the control fields only an
official packager writes (Installed-Size, webOS-Package-Format-Version,
webOS-Packager-Version). This script lays out the app directory and writes
the manifest from what the packager produced.

The server files are exactly deploy.sh's FILES, read from deploy.sh so there is
one list. Nothing else from server/ goes in - in particular no config.json,
which can hold a broker password.

    scripts/build-ipk.py            -> dist/<id>_<version>_all.ipk
                                       dist/<id>.manifest.json

ares-package is found on PATH, or named by $ARES_PACKAGE.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, 'server')
HBC = os.path.join(ROOT, 'hbc')
DIST = os.path.join(ROOT, 'dist')

APP_ID = 'io.github.rorygallagher2024.lg-webos-dashboard'
TITLE = 'Glasshouse'
DESCRIPTION = 'Own the glass. Dashboard, privacy controls and Home Assistant bridge for rooted LG TVs'
REPO = 'https://github.com/rorygallagher2024/lg-webos-dashboard'
ICON_URI = ('https://raw.githubusercontent.com/rorygallagher2024/lg-webos-dashboard/'
            'main/server/assets/dashboard-app/assets/icon130.png')

EXECUTABLE = re.compile(r'(\.sh$|/tvwebctl$|^tvwebctl$)')


def version():
    src = open(os.path.join(SERVER, 'tvweb.js'), encoding='utf-8').read()
    m = re.search(r"^var TVWEB_VERSION = '([^']+)';", src, re.M)
    if not m:
        sys.exit('no TVWEB_VERSION in server/tvweb.js')
    return m.group(1)


def deploy_files():
    src = open(os.path.join(SERVER, 'deploy.sh'), encoding='utf-8').read()
    m = re.search(r'^FILES="(.*?)"', src, re.M | re.S)
    if not m:
        sys.exit('no FILES list in server/deploy.sh')
    return m.group(1).replace('\\\n', ' ').split()


def put(path, data, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    os.chmod(path, mode)


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def stage(app, ver):
    """Lay out the app directory ares-package is given."""
    icons = os.path.join(SERVER, 'assets', 'dashboard-app', 'assets')
    appinfo = {
        'id': APP_ID, 'version': ver, 'vendor': 'lg-webos-dashboard', 'type': 'web',
        'main': 'index.html', 'title': TITLE, 'appDescription': DESCRIPTION,
        'icon': 'icon80.png', 'largeIcon': 'icon130.png',
        'iconColor': '#000000', 'bgColor': '#000000', 'disableBackHistoryAPI': True,
    }
    page = read(os.path.join(HBC, 'app', 'index.html')).decode('utf-8')
    if '@VERSION@' not in page:
        sys.exit('hbc/app/index.html has no @VERSION@ to fill in')

    put(os.path.join(app, 'appinfo.json'), json.dumps(appinfo, indent=2).encode(), 0o644)
    put(os.path.join(app, 'index.html'), page.replace('@VERSION@', ver).encode('utf-8'), 0o644)
    for icon in ('icon80.png', 'icon130.png'):
        put(os.path.join(app, icon), read(os.path.join(icons, icon)), 0o644)
    put(os.path.join(app, 'payload', 'install.sh'), read(os.path.join(HBC, 'install.sh')), 0o755)

    payload = deploy_files() + ['50-tvweb.sh']
    for rel in payload:
        src = os.path.join(SERVER, rel)
        if not os.path.isfile(src):
            sys.exit('deploy.sh lists %s, which does not exist' % rel)
        put(os.path.join(app, 'payload', 'server', rel), read(src),
            0o755 if EXECUTABLE.search(rel) else 0o644)
    return len(payload)


def main():
    ver = version()
    ares = os.environ.get('ARES_PACKAGE') or shutil.which('ares-package')
    if not ares:
        sys.exit('ares-package not found: npm install -g @webos-tools/cli, or set ARES_PACKAGE')

    work = os.path.join(DIST, 'stage')
    shutil.rmtree(work, ignore_errors=True)
    app = os.path.join(work, APP_ID)
    count = stage(app, ver)

    os.makedirs(DIST, exist_ok=True)
    ipk_name = '%s_%s_all.ipk' % (APP_ID, ver)
    ipk_path = os.path.join(DIST, ipk_name)
    if os.path.exists(ipk_path):
        os.remove(ipk_path)
    # --no-minify is accepted though not in its help. Minifying would rewrite
    # the TVWEB_VERSION line the installer and the update check read, and the
    # server has to stay the ES5 that node 0.12 on webOS 4 parses.
    run = subprocess.run([ares, '--no-minify', '--outdir', DIST, app], capture_output=True, text=True)
    if run.returncode != 0 or not os.path.isfile(ipk_path):
        sys.exit('ares-package failed:\n' + run.stdout + run.stderr)
    shutil.rmtree(work, ignore_errors=True)

    ipk = read(ipk_path)
    # ipkUrl is relative, as the Homebrew Channel's own manifest has it: it is
    # resolved against the manifest's URL, so both sit in the same release.
    manifest = {
        'id': APP_ID, 'version': ver, 'type': 'web', 'title': TITLE,
        'appDescription': DESCRIPTION, 'iconUri': ICON_URI, 'sourceUrl': REPO,
        'rootRequired': True, 'ipkUrl': ipk_name,
        'ipkHash': {'sha256': hashlib.sha256(ipk).hexdigest()},
    }
    with open(os.path.join(DIST, APP_ID + '.manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    print('%s  %d files, %d KB' % (ipk_name, count, len(ipk) // 1024))


if __name__ == '__main__':
    main()
