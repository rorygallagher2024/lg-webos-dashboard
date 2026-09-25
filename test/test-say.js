/**
 * test/test-say.js - Server messages come back in the page's language
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'say-')) : path.join(os.tmpdir(), 'say-' + process.pid);
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({
  'srv.power.on': { text: 'Encendida', from: 'On' },
  'srv.saver.clock': { text: 'Reloj', from: 'Clock' },
  'srv.update.failed': { text: 'La actualización falló: {error}', from: 'The update failed: {error}' },
  'srv.daemon.uploadd': { text: 'Cargador de diagnósticos', from: 'Diagnostics uploader' },
  'srv.privacy.running': { text: '{name} en marcha', from: '{name} is running' },
  'srv.old': { text: 'Viejo', from: 'Old words' }
}));

var say = require('../server/lib/say');
var msg = say.msg;
say.init(dir);

console.log('Running test-say.js ...');

// 1. msg() is the plain English, so the server and Home Assistant are unchanged
var on = msg('srv.power.on', 'On');
var failed = msg('srv.update.failed', 'The update failed: {error}', { error: 'disk full' });
var running = msg('srv.privacy.running', '{name} is running', { name: msg('srv.daemon.uploadd', 'Diagnostics uploader') });
var stale = msg('srv.old', 'New words');
assert.strictEqual(on, 'On');
assert.strictEqual(failed, 'The update failed: disk full');
assert.strictEqual(running, 'Diagnostics uploader is running');
console.log('  ✓ msg() returns the English, filled in');

// 2. The page's language comes from its header, and only one with a file
assert.strictEqual(say.langOf({ headers: { 'x-glasshouse-lang': 'es' } }), 'es');
assert.strictEqual(say.langOf({ headers: { 'x-glasshouse-lang': 'fr' } }), null);
assert.strictEqual(say.langOf({ headers: {} }), null);
console.log('  ✓ the language is the one a page asked for, if there is a file');

// 3. Display fields are translated; values, and anything msg() did not make, are not
var body = JSON.stringify({
  ok: false, error: failed,
  powerState: { raw: 'On', label: on },
  modes: [{ id: 'clock', label: msg('srv.saver.clock', 'Clock') }, { id: 'x', label: 'Clock radio' }],
  items: [{ label: running }],
  note: stale
});
var out = JSON.parse(say.translateBody(body, 'es'));
assert.strictEqual(out.error, 'La actualización falló: disk full');
assert.strictEqual(out.powerState.label, 'Encendida');
assert.strictEqual(out.powerState.raw, 'On', 'a raw value reading the same as a message is left alone');
assert.strictEqual(out.modes[0].label, 'Reloj');
assert.strictEqual(out.modes[1].label, 'Clock radio');
assert.strictEqual(out.items[0].label, 'Cargador de diagnósticos en marcha', 'a message inside a message is translated too');
console.log('  ✓ display fields are translated, raw values and other text are not');

// 4. A translation made from different English is not used
assert.strictEqual(out.note, 'New words');
console.log('  ✓ an outdated translation leaves the English');

// 5. English, or a body that is not JSON, goes out as it came
assert.strictEqual(say.translateBody(body, null), body);
assert.strictEqual(say.translateBody('not json', 'es'), 'not json');
console.log('  ✓ English and non-JSON bodies are untouched');

console.log('ALL test-say.js assertions passed!\n');
