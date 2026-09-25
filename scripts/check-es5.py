#!/usr/bin/env python3
"""
Check that the on-TV server is still ES5.

The TV runs node v0.12.2. An ES6 construct is not a degraded feature there, it
is a parse error: node prints "SyntaxError: Unexpected token" and exits, so the
server never binds, the dashboard never answers and the MQTT bridge never
connects. Nothing else in this repo catches that - the check scripts talk to a
running server, and a laptop's node parses all of it happily.

    ./scripts/check-es5.py [files...]

Defaults to the server (tvweb.js and lib/), and the pages the TV's own browser
runs - the dashboard app, setup and the helper they load - whose inline scripts
are checked in place. server/assets/ui.html runs in a phone or computer's
browser and is not restricted.

Strings, template literals, regex literals and comments are blanked before the
scan, so a `=>` inside a string or a comment mentioning `const` is not a hit.

Syntax only. ES6 library calls (Object.assign, Array.from, String.prototype
.includes) parse fine and fail later at the call, which is visible in the log;
a parse error is silent because there is no process left to log it.

Exits non-zero if anything is flagged.
"""
import re, sys, pathlib

# Constructs node 0.12 cannot parse, and what to say about each.
RULES = [
    (r'(?<![.\w$])(?:let|const)\s+(?=[A-Za-z_$\[{])', 'let/const - use var'),
    (r'=>', 'arrow function - use function ()'),
    (r'(?<![.\w$])class(?![\w$])\s*[A-Za-z_$\{]', 'class - use a constructor function'),
    (r'\.\.\.', 'spread/rest - build the array or arguments explicitly'),
    (r'(?<![.\w$])async(?![\w$])\s*(?:function\b|\(|[A-Za-z_$])', 'async - use a callback'),
    (r'(?<![.\w$])await(?![\w$])\s', 'await - use a callback'),
    (r'(?<![.\w$])yield(?![\w$])', 'yield - generators are ES6'),
    (r'(?<![.\w$])function\s*\*', 'generator function'),
    (r'(?<![.\w$])for\s*\(\s*(?:var\s+|let\s+|const\s+)?[A-Za-z_$][\w$]*\s+of(?![\w$])',
     'for...of - use an index loop'),
    (r'(?<![.\w$])function\s*[A-Za-z_$\w]*\s*\([^)]*=[^)]*\)\s*\{', 'default parameter value'),
]


def blank(src):
    """
    Replace comment, string, template and regex bodies with spaces, keeping
    every newline so line numbers still line up. Returns the blanked source and
    the lines on which a template literal was opened - backticks are themselves
    ES6, and blanking one would otherwise hide it.
    """
    out, templates = [], []
    i, n, line = 0, len(src), 1
    # A '/' opens a regex rather than dividing when the last meaningful token
    # cannot end an expression.
    prev = ''

    def keep(ch):
        out.append(ch)

    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
            keep(c)
            i += 1
            continue

        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                keep(' ')
                i += 1
            continue

        if c == '/' and i + 1 < n and src[i + 1] == '*':
            while i < n and not (src[i] == '*' and i + 1 < n and src[i + 1] == '/'):
                keep('\n' if src[i] == '\n' else ' ')
                if src[i] == '\n':
                    line += 1
                i += 1
            for _ in range(min(2, n - i)):
                keep(' ')
                i += 1
            continue

        if c in '"\'':
            quote = c
            keep(' ')
            i += 1
            while i < n and src[i] != quote:
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                if i < n:
                    keep('\n' if src[i] == '\n' else ' ')
                    if src[i] == '\n':
                        line += 1
                    i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if c == '`':
            templates.append(line)
            depth = 0
            keep(' ')
            i += 1
            while i < n:
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                    if i < n:
                        keep(' ')
                        i += 1
                    continue
                if src[i] == '$' and i + 1 < n and src[i + 1] == '{':
                    depth += 1
                elif src[i] == '}' and depth:
                    depth -= 1
                elif src[i] == '`' and not depth:
                    break
                keep('\n' if src[i] == '\n' else ' ')
                if src[i] == '\n':
                    line += 1
                i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if c == '/' and prev not in ('x', ')', ']'):
            # Regex literal: run to the closing '/', skipping escapes and the
            # character class, where '/' is literal.
            keep(' ')
            i += 1
            klass = False
            while i < n and src[i] != '\n':
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                    if i < n:
                        keep(' ')
                        i += 1
                    continue
                if src[i] == '[':
                    klass = True
                elif src[i] == ']':
                    klass = False
                elif src[i] == '/' and not klass:
                    break
                keep(' ')
                i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if not c.isspace():
            prev = 'x' if (c.isalnum() or c in '_$)]') else c
        keep(c)
        i += 1

    return ''.join(out), templates


def check(path):
    src = path.read_text(encoding='utf-8')
    if path.suffix == '.html':
        # Inline scripts only, each left on its own lines so a hit reports the
        # page's line number; the markup around them becomes blank lines.
        src = re.sub(r'(?s)(^|</script>).*?(<script>|$)',
                     lambda m: '\n' * m.group(0).count('\n'), src)
    code, templates = blank(src)
    hits = [(ln, 'template literal - use string concatenation') for ln in templates]
    for pattern, why in RULES:
        for m in re.finditer(pattern, code):
            hits.append((code[:m.start()].count('\n') + 1, why))
    for ln, why in sorted(hits):
        print('%s:%d: %s' % (path, ln, why))
    print('%s: %d line%s, %d ES6 construct%s'
          % (path, src.count('\n') + 1, '' if src.count('\n') == 0 else 's',
             len(hits), '' if len(hits) == 1 else 's'))
    return len(hits)


if len(sys.argv) > 1:
    targets = [pathlib.Path(a) for a in sys.argv[1:]]
else:
    root = pathlib.Path(__file__).resolve().parent.parent
    targets = [root / 'server' / 'tvweb.js']
    lib_dir = root / 'server' / 'lib'
    if lib_dir.exists():
        targets.extend(sorted(lib_dir.glob('*.js')))
    # The pages the TV's own browser runs, and the helper they load: on webOS 4
    # it parses nothing newer. ui.html is for a phone or computer's browser.
    assets = root / 'server' / 'assets'
    targets += [assets / 'i18n.js', assets / 'dashboard.html', assets / 'setup.html', assets / 'setup-phone.html']

sys.exit(1 if sum(check(t) for t in targets) else 0)
