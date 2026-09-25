#!/usr/bin/env python3
"""
Check the dashboards' strings and their translations. docs/STRINGS.md has the
rules this enforces.

Every string shown is written in English where it is used, with a key:

    <div data-t="server.updates">Server updates</div>
    t('server.install', 'Install v{version}', { version: v })

A translation in server/assets/i18n/<lang>.json holds the same key, the
translated text and the English it was made from.

Fails on:
  * a key used with two different English texts - one of them is stale
  * a key not written as lowercase words joined by dots and camelCase
  * t() called without a literal key and literal English
  * an element tagged data-t that holds other elements, or whose text the page's
    script rewrites - either way the markup is not the whole string
  * visible text, or a title/aria-label/placeholder, without a key inside a part
    of a page already converted (CONVERTED below)
  * a local variable named t in a page that uses t(), which would hide it
  * a translation with a key no longer used, or with placeholders that differ
    from the English
  * a language listed in i18n.js without a file, or a file not listed

Lists without failing:
  * translations made from English that has since changed (outdated): the page
    shows the English until they are redone, so an English edit never blocks
  * with --missing, strings a language has no translation for yet

    ./scripts/check-strings.py              check
    ./scripts/check-strings.py --missing    also list untranslated strings
    ./scripts/check-strings.py --template   print every key and its English as
                                            a starting file for a new language
"""
import html, html.parser, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'server' / 'assets'
PAGES = ['ui.html', 'dashboard.html', 'setup.html', 'setup-phone.html']
I18N_JS = ASSETS / 'i18n.js'
LANG_DIR = ASSETS / 'i18n'

# Parts of pages whose visible text must all be keyed, by element id. A part is
# added here once converted, so the check holds it there from then on.
CONVERTED = {
    'ui.html': ['serverpane'],
}

KEY_RE = re.compile(r'^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$')
TEXT_ATTRS = ('title', 'aria-label', 'placeholder')
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}

problems = []
uses = {}      # key -> {english: [where, ...]}


def squash(s):
    return re.sub(r'\s+', ' ', s).strip()


def placeholders(s):
    return sorted(set(re.findall(r'\{(\w+)\}', s)))


def note(key, english, where):
    if not KEY_RE.match(key):
        problems.append('%s: key "%s" is not dotted lowercase/camelCase words' % (where, key))
    uses.setdefault(key, {}).setdefault(english, []).append(where)


# ---- markup ---------------------------------------------------------------

class Markup(html.parser.HTMLParser):
    """Collects data-t strings, and text left unkeyed inside converted parts."""

    def __init__(self, name, scopes):
        super().__init__(convert_charrefs=True)
        self.name, self.scopes = name, set(scopes)
        self.stack = []          # [tag, keyed, in_scope, id]
        self.keyed = None        # [key, text parts, line, has child element]
        self.in_code = 0
        self.keyed_ids = {}

    def where(self):
        return '%s:%d' % (self.name, self.getpos()[0])

    def in_scope(self):
        return any(entry[2] for entry in self.stack)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style'):
            self.in_code += 1
        if self.keyed is not None:
            self.keyed[3] = True
        scope = a.get('id') in self.scopes or self.in_scope()
        for attr in TEXT_ATTRS:
            val = a.get(attr)
            key = a.get('data-t-' + attr)
            if key:
                note(key, squash(val or ''), self.where())
            elif scope and val and re.search(r'[A-Za-z]{2}', val):
                problems.append('%s: %s="%s" has no data-t-%s key' % (self.where(), attr, squash(val), attr))
        if 'data-t' in a:
            self.keyed = [a['data-t'], [], self.where(), False]
            if a.get('id'):
                self.keyed_ids[a['id']] = self.where()
        if tag not in VOID:
            self.stack.append([tag, 'data-t' in a, scope, a.get('id')])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.in_code = max(0, self.in_code - 1)
        while self.stack:
            entry = self.stack.pop()
            if entry[0] == tag:
                break
        if self.keyed is not None and not any(e[1] for e in self.stack):
            key, parts, where, child = self.keyed
            self.keyed = None
            if child:
                problems.append('%s: data-t="%s" holds other elements; key the text alone' % (where, key))
            else:
                note(key, squash(''.join(parts)), where)

    def handle_data(self, data):
        if self.in_code:
            return
        if self.keyed is not None:
            self.keyed[1].append(data)
        elif self.in_scope() and re.search(r'[A-Za-z]{2}', data):
            problems.append('%s: "%s" has no data-t key' % (self.where(), squash(data)[:60]))


# ---- script ---------------------------------------------------------------

def strip_code(src):
    """The script with comments blanked and every string/regex kept whole, and
    the spans of string literals, so t( inside a string or comment is ignored."""
    out, i, n = [], 0, len(src)
    last = ''                    # last significant character, to tell / apart
    while i < n:
        c = src[i]
        if src.startswith('//', i):
            j = src.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i)); i = j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r'[^\n]', ' ', src[i:j])); i = j; continue
        if c in '\'"`' or (c == '/' and (last == '' or last in '(,=:[!&|?{};+-*%<>~^')):
            q, j = c, i + 1
            in_class = False
            while j < n:
                if src[j] == '\\':
                    j += 2; continue
                if q == '/' and src[j] == '[':
                    in_class = True
                elif q == '/' and src[j] == ']':
                    in_class = False
                elif src[j] == q and not in_class:
                    break
                elif src[j] == '\n' and q != '`':
                    break
                j += 1
            out.append(src[i:j + 1]); last = q; i = j + 1; continue
        out.append(c)
        if not c.isspace():
            last = c
        i += 1
    return ''.join(out)


def js_string(src, i):
    """A string literal at src[i]: (value, end) or None."""
    q = src[i] if i < len(src) else ''
    if q not in '\'"`':
        return None
    j, val = i + 1, []
    while j < len(src) and src[j] != q:
        if q == '`' and src.startswith('${', j):
            return None
        if src[j] == '\\':
            nxt = src[j + 1]
            if nxt == 'u':
                val.append(chr(int(src[j + 2:j + 6], 16))); j += 6; continue
            val.append({'n': '\n', 't': '\t'}.get(nxt, nxt)); j += 2; continue
        val.append(src[j]); j += 1
    return ''.join(val), j + 1


def scan_script(name, src, offset_line):
    code = strip_code(src)
    for m in re.finditer(r'(?<![\w$.])t\(', code):
        start = m.end()
        where = '%s:%d' % (name, offset_line + src.count('\n', 0, m.start()))
        rest = code[start:].lstrip()
        if rest.startswith(')'):
            continue                                   # a mention: "t()"
        i = start + (len(code[start:]) - len(rest))
        key = js_string(src, i)
        if not key:
            problems.append('%s: t() needs a literal key' % where)
            continue
        j = key[1]
        while src[j].isspace():
            j += 1
        if src[j] != ',':
            problems.append('%s: t(\'%s\') needs its English as the second argument' % (where, key[0]))
            continue
        j += 1
        while src[j].isspace():
            j += 1
        english = js_string(src, j)
        if not english:
            problems.append('%s: t(\'%s\', ...) needs literal English' % (where, key[0]))
            continue
        note(key[0], english[0], where)
    for m in re.finditer(r'(?:\b(?:const|let|var)\s+t\b|\(\s*t\s*[,)]|\bt\s*=>|function\s*\w*\s*\(\s*t\s*[,)])', code):
        problems.append('%s:%d: a local named t hides t()' % (name, offset_line + src.count('\n', 0, m.start())))
    return code


def uses_in(page):
    return any(w.startswith(page + ':') for texts in uses.values() for ws in texts.values() for w in ws)


def rewritten_ids(code):
    return set(re.findall(r"""q\(\s*['"]([\w-]+)['"]\s*\)\s*\.\s*(?:textContent|innerHTML|innerText)\s*=""", code))


# ---- run ------------------------------------------------------------------

for page in PAGES:
    path = ASSETS / page
    src = path.read_text(encoding='utf-8')
    parser = Markup(page, CONVERTED.get(page, []))
    parser.feed(src)
    missing_scopes = [s for s in CONVERTED.get(page, []) if 'id="%s"' % s not in src]
    for s in missing_scopes:
        problems.append('%s: converted part #%s no longer exists' % (page, s))
    # Only a page that loads the helper can call t(); its other scripts are left be.
    if '/assets/i18n.js' not in src:
        if parser.keyed_ids or uses_in(page):
            problems.append('%s: uses keys but does not load /assets/i18n.js' % page)
        continue
    code = ''
    for m in re.finditer(r'<script>([\s\S]*?)</script>', src):
        code += scan_script(page, m.group(1), src.count('\n', 0, m.start(1)) + 1)
    for el_id in rewritten_ids(code) & set(parser.keyed_ids):
        problems.append('%s: #%s is tagged data-t but the script rewrites it; key it in the script instead'
                        % (parser.keyed_ids[el_id], el_id))

for key, texts in sorted(uses.items()):
    if len(texts) > 1:
        detail = '; '.join('"%s" at %s' % (e, ', '.join(w)) for e, w in texts.items())
        problems.append('key "%s" has different English in different places: %s' % (key, detail))

english = {k: next(iter(v)) for k, v in uses.items()}

if '--template' in sys.argv:
    print(json.dumps({k: {'text': '', 'from': english[k]} for k in sorted(english)},
                     ensure_ascii=False, indent=2))
    sys.exit(0)

listed = re.search(r'var LANGS = \[([^\]]*)\]', I18N_JS.read_text(encoding='utf-8'))
listed = set(re.findall(r"'([a-z]{2})'", listed.group(1))) if listed else set()
files = {p.stem: p for p in sorted(LANG_DIR.glob('*.json'))} if LANG_DIR.exists() else {}
for lang in sorted(listed - set(files)):
    problems.append('i18n.js lists "%s" but there is no i18n/%s.json' % (lang, lang))
for lang in sorted(set(files) - listed):
    problems.append('i18n/%s.json exists but i18n.js does not list "%s", so it is never loaded' % (lang, lang))

report = []
for lang, path in files.items():
    try:
        tr = json.loads(path.read_text(encoding='utf-8'))
    except ValueError as e:
        problems.append('i18n/%s.json does not parse: %s' % (lang, e))
        continue
    outdated, done = [], 0
    for key, entry in sorted(tr.items()):
        if key not in english:
            problems.append('i18n/%s.json: "%s" is not used anywhere' % (lang, key))
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get('text'), str) or not isinstance(entry.get('from'), str):
            problems.append('i18n/%s.json: "%s" needs "text" and "from"' % (lang, key))
            continue
        if placeholders(entry['text']) != placeholders(english[key]):
            problems.append('i18n/%s.json: "%s" has placeholders %s, the English has %s'
                            % (lang, key, placeholders(entry['text']), placeholders(english[key])))
        if entry['from'] != english[key]:
            outdated.append(key)
        else:
            done += 1
    missing = sorted(set(english) - set(tr))
    report.append('%s: %d translated, %d outdated, %d missing' % (lang, done, len(outdated), len(missing)))
    for key in outdated:
        report.append('  outdated %s: now "%s"' % (key, english[key]))
    if '--missing' in sys.argv:
        for key in missing:
            report.append('  missing  %s: "%s"' % (key, english[key]))

for p in problems:
    print(p)
for line in report:
    print(line)
print('%d strings keyed, %d language file%s, %d problem%s'
      % (len(english), len(files), '' if len(files) == 1 else 's', len(problems), '' if len(problems) == 1 else 's'))
sys.exit(1 if problems else 0)
