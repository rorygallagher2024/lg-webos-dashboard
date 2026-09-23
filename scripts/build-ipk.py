#!/usr/bin/env python3
"""
Build the app the Homebrew Channel installs: an .ipk carrying the launch page
and, under payload/, the server itself, plus the manifest that the Homebrew
Channel's repository points at.

The server files are exactly deploy.sh's FILES, read from deploy.sh so there is
one list. Nothing else from server/ goes in - in particular no config.json,
which can hold a broker password.

    scripts/build-ipk.py            -> dist/<id>_<version>_all.ipk
                                       dist/<id>.manifest.json
"""

import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile

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


def add(tar, name, data, mode):
    """Owned by root, dated 0, so the same sources always build the same file."""
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mtime = 0
    tar.addfile(info, io.BytesIO(data))


def add_dir(tar, name):
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mtime = 0
    tar.addfile(info)


def targz(entries):
    """entries: list of (path, bytes or None for a directory, mode)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for path, data, mode in entries:
            if data is None:
                add_dir(tar, path)
            else:
                add(tar, path, data, mode)
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def ar(members):
    """The ipk format is an ar archive of three members with 60-byte headers."""
    out = bytearray(b'!<arch>\n')
    for name, data in members:
        out += ('%-16s%-12d%-6d%-6d%-8s%-10d`\n' % (name, 0, 0, 0, '100644', len(data))).encode()
        out += data
        if len(data) % 2:
            out += b'\n'
    return bytes(out)


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def main():
    ver = version()
    appdir = './usr/palm/applications/%s/' % APP_ID
    pkgdir = './usr/palm/packages/%s/' % APP_ID
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
    page = page.replace('@VERSION@', ver)

    entries = [('./usr/', None, 0), ('./usr/palm/', None, 0),
               ('./usr/palm/applications/', None, 0), (appdir, None, 0),
               ('./usr/palm/packages/', None, 0), (pkgdir, None, 0),
               (appdir + 'appinfo.json', json.dumps(appinfo, indent=2).encode(), 0o644),
               (appdir + 'index.html', page.encode('utf-8'), 0o644),
               (appdir + 'icon80.png', read(os.path.join(icons, 'icon80.png')), 0o644),
               (appdir + 'icon130.png', read(os.path.join(icons, 'icon130.png')), 0o644),
               (appdir + 'payload/', None, 0),
               (appdir + 'payload/install.sh', read(os.path.join(HBC, 'install.sh')), 0o755)]

    # Directories first, parents before children, then the files in them.
    payload = deploy_files() + ['50-tvweb.sh']
    base = appdir + 'payload/server/'
    dirs = {base}
    for rel in payload:
        parts = rel.split('/')[:-1]
        for i in range(len(parts)):
            dirs.add(base + '/'.join(parts[:i + 1]) + '/')
    entries += [(d, None, 0) for d in sorted(dirs)]
    for rel in payload:
        src = os.path.join(SERVER, rel)
        if not os.path.isfile(src):
            sys.exit('deploy.sh lists %s, which does not exist' % rel)
        mode = 0o755 if EXECUTABLE.search(rel) else 0o644
        entries.append((base + rel, read(src), mode))

    packageinfo = {'id': APP_ID, 'version': ver, 'app': APP_ID, 'loc_name': TITLE, 'vendor': 'lg-webos-dashboard'}
    entries.append((pkgdir + 'packageinfo.json', json.dumps(packageinfo).encode(), 0o644))

    control = ('Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: %s\nDescription: %s\n'
               % (APP_ID, ver, REPO, DESCRIPTION)).encode()
    ipk = ar([('debian-binary', b'2.0\n'),
              ('control.tar.gz', targz([('./control', control, 0o644)])),
              ('data.tar.gz', targz(entries))])

    os.makedirs(DIST, exist_ok=True)
    ipk_name = '%s_%s_all.ipk' % (APP_ID, ver)
    with open(os.path.join(DIST, ipk_name), 'wb') as f:
        f.write(ipk)

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

    print('%s  %d files, %d KB' % (ipk_name, len(payload), len(ipk) // 1024))


if __name__ == '__main__':
    main()
