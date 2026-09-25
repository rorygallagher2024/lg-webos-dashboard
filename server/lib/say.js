/*
 * Messages the server shows on the dashboards, in English, with a key.
 *
 *   error: msg('srv.saver.switching', 'The TV is still switching screen savers.')
 *   error: msg('srv.update.failed', 'The update failed: {error}', { error: e.message })
 *
 * msg() returns the plain English string, so everything that compares, joins
 * or logs it works as before, and Home Assistant, MQTT and the log stay in
 * English. It also remembers which key and English template the string came
 * from. When a dashboard asks for another language, translate() swaps such
 * strings for the translation in the fields a page shows (DISPLAY_FIELDS),
 * using the same files as the pages: server/assets/i18n/<lang>.json.
 *
 * Only display fields are touched, so a raw value that happens to read the same
 * as a message - a TV state such as "Running" - is never changed.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var fs = require('fs');
var path = require('path');

var DISPLAY_FIELDS = {
  error: 1, note: 1, label: 1, name: 1, detail: 1, desc: 1, description: 1,
  title: 1, badge: 1, message: 1, hint: 1, limitTrackingLabel: 1, limitTrackingDetail: 1,
  // Lists of the names above, which a page joins into a sentence.
  sharesWith: 1, agreements: 1, kept: 1,
  // [id, title, note] rows: only the strings msg() made are changed, never an id.
  consentGroups: 1
};

// Filled English -> { key, en, vars }. A fixed message, such as a screen
// saver's name, is remembered for good: it is made once, at load. One with
// values is bounded, since an error carrying a changing detail makes a new
// entry each time.
var MAX_FILLED = 1000;
var fixed = {};
var filled = {};
var filledCount = 0;

var dicts = {};              // lang -> { key: { text, from } }
var langDir = null;

function fill(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, function (whole, name) {
    return vars[name] === undefined ? whole : String(vars[name]);
  });
}

function msg(key, en, vars) {
  var text = fill(en, vars);
  if (!vars) {
    fixed[text] = { key: key, en: en, vars: null };
    return text;
  }
  if (!Object.prototype.hasOwnProperty.call(filled, text)) {
    if (filledCount >= MAX_FILLED) { filled = {}; filledCount = 0; }
    filledCount++;
  }
  filled[text] = { key: key, en: en, vars: vars };
  return text;
}

// "A, B and C" as a message, so the joining word follows the page's language
// too. The items are left as they are: they may be messages themselves, or
// names the TV gave in its own language.
function list(items) {
  if (items.length < 2) return items[0] || '';
  return msg('srv.list', '{items} and {last}', { items: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

// The language files beside the pages. Read once; a new release restarts the
// server, which is when they change.
function init(dir) {
  langDir = dir;
  dicts = {};
  var files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return; }
  for (var i = 0; i < files.length; i++) {
    var m = /^([a-z]{2})\.json$/.exec(files[i]);
    if (!m) continue;
    try { dicts[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8')); }
    catch (e) { console.error('strings: ' + files[i] + ' did not parse: ' + e.message); }
  }
}

// The language a page asked for, if there is a file for it.
function langOf(req) {
  var want = String((req && req.headers && req.headers['x-glasshouse-lang']) || '').toLowerCase();
  return /^[a-z]{2}$/.test(want) && want !== 'en' && dicts[want] ? want : null;
}

function translateText(text, dict) {
  var has = Object.prototype.hasOwnProperty;
  var m = has.call(fixed, text) ? fixed[text] : has.call(filled, text) ? filled[text] : null;
  if (!m) return text;
  var entry = Object.prototype.hasOwnProperty.call(dict, m.key) ? dict[m.key] : null;
  // Made from different English: show the English until it is redone.
  if (!entry || entry.from !== m.en || typeof entry.text !== 'string' || !entry.text) return text;
  // A value can be a message itself, such as a service's name.
  var vars = null;
  if (m.vars) {
    vars = {};
    for (var k in m.vars) {
      if (has.call(m.vars, k)) vars[k] = typeof m.vars[k] === 'string' ? translateText(m.vars[k], dict) : m.vars[k];
    }
  }
  return fill(entry.text, vars);
}

function walk(v, dict, field) {
  if (typeof v === 'string') return field && DISPLAY_FIELDS[field] ? translateText(v, dict) : v;
  if (Array.isArray(v)) {
    // An array of strings in a display field, such as a list of names.
    for (var i = 0; i < v.length; i++) v[i] = walk(v[i], dict, field);
    return v;
  }
  if (v && typeof v === 'object') {
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = walk(v[k], dict, k);
    }
  }
  return v;
}

// A JSON body for a response, translated in place where a page asked for a
// language. Anything that is not JSON goes out as it came.
function translateBody(body, lang) {
  if (!lang || typeof body !== 'string' || !dicts[lang]) return body;
  var obj;
  try { obj = JSON.parse(body); } catch (e) { return body; }
  return JSON.stringify(walk(obj, dicts[lang], null));
}

module.exports = {
  msg: msg,
  list: list,
  init: init,
  langOf: langOf,
  translateBody: translateBody,
  DISPLAY_FIELDS: DISPLAY_FIELDS
};
