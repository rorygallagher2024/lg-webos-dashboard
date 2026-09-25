/*
 * Strings shown on the dashboards, and their translations.
 *
 * English is written where each string is used, next to a key that names it:
 *
 *   <div data-t="server.updates">Server updates</div>
 *   t('server.install', 'Install v{version}', { version: v })
 *
 * A translation lives in /assets/i18n/<lang>.json under the same key, with the
 * English it was made from:
 *
 *   { "server.updates": { "text": "Actualizaciones", "from": "Server updates" } }
 *
 * When the English changes, "from" no longer matches and the English is shown
 * until the translation is redone, rather than a translation of the old words.
 * docs/STRINGS.md has the rules; scripts/check-strings.py enforces them.
 *
 * ES5: the dashboard on the TV runs in the TV's own browser, which on webOS 4
 * parses nothing newer.
 */
(function (root) {
  // Languages that have a file in /assets/i18n/. English needs none.
  var LANGS = [];

  var dict = {};
  var lang = 'en';

  function pick() {
    var m = /[?&]lang=([a-z]{2})/i.exec(location.search);
    var want = m ? m[1] : ((navigator.languages && navigator.languages[0]) || navigator.language || 'en');
    want = String(want).slice(0, 2).toLowerCase();
    return LANGS.indexOf(want) >= 0 ? want : 'en';
  }

  /*
   * Synchronous, so every string on the page, and every one built after it,
   * comes out in the one language from the first paint. The file is small and
   * on the same TV; an asynchronous load would show English first and need each
   * page to start over once it arrived.
   */
  function load() {
    lang = pick();
    if (lang === 'en') return;
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/assets/i18n/' + lang + '.json', false);
      x.send(null);
      if (x.status === 200) dict = JSON.parse(x.responseText);
      document.documentElement.setAttribute('lang', lang);
    } catch (e) {
      dict = {};
      lang = 'en';
    }
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      return vars[name] === undefined ? whole : String(vars[name]);
    });
  }

  // The key is what a translation is looked up by; the English is shown when
  // there is none, or when the one there was made from different words.
  function t(key, english, vars) {
    var entry = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
    return fill(entry && entry.from === english ? entry.text : english, vars);
  }

  // Markup text is written across lines like any other; compare it as it reads.
  function squash(s) {
    return String(s).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  // Text in the markup: data-t on the element holding it, data-t-title and the
  // like for an attribute. Nothing to do in English, which is already there.
  function apply(scope) {
    if (lang === 'en') return;
    var els = (scope || document).querySelectorAll('[data-t]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-t'), squash(els[i].textContent));
    }
    var attrs = ['title', 'aria-label', 'placeholder'];
    for (var a = 0; a < attrs.length; a++) {
      var named = (scope || document).querySelectorAll('[data-t-' + attrs[a] + ']');
      for (var j = 0; j < named.length; j++) {
        var el = named[j];
        el.setAttribute(attrs[a], t(el.getAttribute('data-t-' + attrs[a]), squash(el.getAttribute(attrs[a]) || '')));
      }
    }
  }

  /*
   * Messages from the server - errors, and names such as a screen saver's -
   * come back in the page's language when it says which it is on its own
   * requests. English says nothing, and the server answers in English.
   */
  function tellServer() {
    if (lang === 'en') return;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try { this.setRequestHeader('X-Glasshouse-Lang', lang); } catch (e) {}
      return send.apply(this, arguments);
    };
    if (root.fetch && root.Headers) {
      var fetch = root.fetch;
      root.fetch = function (input, init) {
        init = init || {};
        var headers = new root.Headers(init.headers || (input && input.headers) || {});
        headers.set('X-Glasshouse-Lang', lang);
        init.headers = headers;
        return fetch.call(this, input, init);
      };
    }
  }

  load();
  tellServer();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); });
  } else {
    apply();
  }

  root.t = t;
  root.I18N = { t: t, apply: apply, lang: function () { return lang; }, languages: LANGS };
// Untyped for the type check, which does not know the two names added to it.
})(/** @type {any} */ (window));
