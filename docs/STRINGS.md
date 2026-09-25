# Strings

Text shown on the dashboards is written in English where it is used, with a key
next to it. A translation is a file that maps the same keys to another language.
English needs no file, so reading the markup or the script shows the real words.

`scripts/check-strings.py` enforces what follows, and runs in CI.

## Adding a string

In markup, key the element that holds the text, and nothing but the text:

```html
<div class="prot-title" data-t="server.checkDaily">Check daily</div>
<button data-t="server.checkNow">Check now</button>
```

An attribute takes `data-t-` and its name, with the English in the attribute:

```html
<div role="group" aria-label="Theme" data-t-aria-label="theme">
```

`title`, `aria-label` and `placeholder` are covered.

In the page's script, call `t()` with a literal key and literal English. Values
go in through named placeholders:

```js
t('server.install', 'Install v{version}', { version: v })
```

## Keys

Lowercase words joined by dots, camelCase within a word:
`server.tvUpdates.block.desc`. Start with the tab or page (`server.`, `adv.`),
or `common.` for words used across it such as `common.on`.

One key, one English text. Where the same words appear in several places, such
as a description on both dashboards, use the same key, so the check notices when
one copy is edited and the others are not. Different wording needs a different
key.

## Rules

- **Whole sentences.** Never build a sentence from pieces such as
  `n + t('x', ' of ') + total`. Other languages order words differently. Put the
  sentence in one string with placeholders: `'{n} of {total} on'`.
- **Never translate a value.** Anything compared with what the TV reports, sent
  to the server or the TV, or used as a state stays in English. Only what is
  shown goes through `t()`. Keep state in a variable or `dataset`, never read it
  back from displayed text.
- **Script-owned text is keyed in the script.** An element whose text the script
  sets gets no `data-t`, and holds a placeholder such as `&mdash;` in the
  markup until the script fills it.
- **No local variable named `t`** in a page that loads `/assets/i18n.js`. It
  would hide `t()` in that function.
- **Messages from the server** still arrive in English. They are not translated
  yet.

## Converting part of a page

Key every piece of text in it, then add the element's id to `CONVERTED` in
`scripts/check-strings.py`. From then on, text added there without a key fails
the check.

## Adding a language

1. `./scripts/check-strings.py --template > server/assets/i18n/<lang>.json`
   writes every key with its English as `from` and an empty `text`.
2. Fill in `text`, keeping each `{placeholder}` as it is. An entry left out, or
   left empty, shows in English.
3. Add the two-letter code to `LANGS` in `server/assets/i18n.js`, and the file
   to `FILES` in `server/deploy.sh`.

The page follows the browser's language. `?lang=es` picks one for testing.

## Keeping a translation current

Each entry records the English it was translated from. When the English changes,
the entry is **outdated**: the page shows the new English, not a translation of
the old words, and `./scripts/check-strings.py` lists it with the new English to
translate. Outdated entries never fail the check, so editing English is never
blocked on a translation. `--missing` lists strings a language has no entry for.
