#!/usr/bin/env python3
"""
Check the two lists that are maintained by hand against what the code does.

Both fail silently, which is why they are checked rather than remembered:

  * docs/HOME-ASSISTANT.md is the entity reference, so an entity added to
    ha.js, renamed or dropped leaves the table wrong with nothing to notice.
    It had cpu_load documented under its old id and mac_address not at all.
  * deploy.sh copies a hardcoded FILES list. An asset added to server/assets
    and left out of it is simply never installed, and the TV falls back to
    whatever the previous deploy left there - so the feature works on the
    developer's set and on nobody else's.

    ./scripts/check-drift.py

Exits non-zero if either has fallen out of step.
"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
doc_path = root / 'docs' / 'HOME-ASSISTANT.md'
problems = []

DECL = r"type:\s*'(\w+)',\s*\n?\s*id:\s*'(\w+)'"
# | `sensor` | `sensor.lg_tv_soc_temperature` | SoC Temperature | ... |
ROW = re.compile(r'^\|\s*`(\w+)`\s*\|\s*`(\w+)\.lg_tv_(\w+)`', re.M)


def published():
    """Discovery configs published on a fully-capable set with allowPower on."""
    ha_path = root / 'server' / 'lib' / 'ha.js'
    target = ha_path if ha_path.exists() else (root / 'server' / 'tvweb.js')
    src = target.read_text(encoding='utf-8')
    start = src.index('var entities = [')
    open_at = start + src[start:].index('[')
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == '[':
            depth += 1
        elif src[i] == ']':
            depth -= 1
            if depth == 0:
                end = i
                break
    else:
        sys.exit('check-drift: could not find the end of the entities array')

    in_array = re.findall(DECL, src[open_at:end])
    # The power entities are pushed after the literal, under CONFIG.allowPower.
    pushed = re.findall(r"entities\.push\(\{\s*\n?\s*" + DECL, src[end:])
    return set(in_array + pushed)


def documented():
    """
    Entities the reference lists, by the id Home Assistant gives them. The
    domain is written twice in each row - its own column and the entity id -
    and a row that disagrees with itself is a copy-and-paste left half-edited.
    """
    rows = ROW.findall(doc_path.read_text(encoding='utf-8'))
    for column, domain, name in rows:
        if column != domain:
            problems.append('docs/HOME-ASSISTANT.md: %s.lg_tv_%s is in a `%s` row'
                            % (domain, name, column))
    return {(domain, name) for _, domain, name in rows}


def check_entities(in_code, in_doc):
    where = doc_path.relative_to(root)
    for domain, name in sorted(in_code - in_doc):
        problems.append('%s: %s.lg_tv_%s is published but not documented' % (where, domain, name))
    for domain, name in sorted(in_doc - in_code):
        problems.append('%s: documents %s.lg_tv_%s, which is not published' % (where, domain, name))
    if not in_doc:
        problems.append('%s: no entity rows found - has the table changed shape?' % where)


def check_deploy():
    deploy = (root / 'server' / 'deploy.sh').read_text(encoding='utf-8')
    m = re.search(r'^FILES="(.*?)"', deploy, re.S | re.M)
    if not m:
        problems.append('server/deploy.sh: no FILES list found')
        return set()
    listed = set(m.group(1).replace('\\\n', ' ').split())
    on_disk = set()
    scan_dirs = [root / 'server' / 'assets', root / 'server' / 'lib']
    for d in scan_dirs:
        if d.exists():
            for f in d.rglob('*'):
                if f.is_file():
                    on_disk.add(str(f.relative_to(root / 'server')))
    for missing in sorted(on_disk - listed):
        problems.append('server/deploy.sh: %s is not in FILES, so it is never installed' % missing)
    for gone in sorted(f for f in listed - on_disk if f.startswith('assets/') or f.startswith('lib/')):
        problems.append('server/deploy.sh: FILES lists %s, which does not exist' % gone)
    return on_disk


in_code = published()
in_doc = documented()
check_entities(in_code, in_doc)
assets = check_deploy()

for p in problems:
    print(p)
print('%d entities published, %d documented, %d assets in FILES, %d problem%s'
      % (len(in_code), len(in_doc), len(assets), len(problems), '' if len(problems) == 1 else 's'))
sys.exit(1 if problems else 0)
