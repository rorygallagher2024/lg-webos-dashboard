/**
 * test/test-lgsettings.js - LG's own settings as switches
 */

var assert = require('assert');
var lgs = require('../server/lib/lgsettings');

console.log('Running test-lgsettings.js ...');

// A B8-like TV: no screen saver ads, no smart tips, no Content Recommendation.
var stored = {
  general: { homePromotion: 'on', adCookie: 'on' },
  other: {},
  option: { livePromotion: 'off' }
};
var reads = 0, writes = [], cleared = 0;
var described = {};
var greyed = {};
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: described[payload.category] || [] });
    reads++;
    cb({ returnValue: true, settings: stored[payload.category] || {} });
  },
  luna: function (uri, payload, cb) {
    if (/Desc$/.test(uri)) return cb({ returnValue: true, results: greyed[payload.keys[0]] ? [{ key: payload.keys[0], ui: { active: false } }] : [] });
    writes.push(payload);
    cb({ returnValue: true });
  },
  clearLunaCache: function () { cleared++; }
});

// 1. Only the rows the TV has come back, one read per category of the section
lgs.collect('promotions', function (r) {
  assert.strictEqual(r.ok, true);
  var ids = r.rows.map(function (x) { return x.id; });
  assert.deepEqual(ids, ['homePromotion', 'livePromotion']);
  assert.strictEqual(r.rows[0].on, true);
  assert.strictEqual(r.rows[1].on, false);
  assert.strictEqual(reads, 3);
  console.log('  ✓ a TV without a setting does not offer it');
});

// 2. Writing stores LG's value for the row, and drops cached reads
lgs.set('homePromotion', false, function (r) {
  assert.strictEqual(r.ok, true);
  assert.deepEqual(writes[0], { category: 'general', settings: { homePromotion: 'off' } });
  assert.strictEqual(cleared, 1);
  console.log('  ✓ a switch writes the value LG stores');
});

// 3. Choices and numbers take only their own values, and report the dimension
stored.other = { gameGenre: 'Standard', blackStabilizer: 10 };
stored.sound = { aigamesound: 'on' };
lgs.collect('game', function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.strictEqual(by.gameGenre.type, 'choice');
  assert.strictEqual(by.gameGenre.value, 'Standard');
  assert.strictEqual(by.blackStabilizer.min, 0);
  assert.strictEqual(by.aigamesound.on, true);
  assert.strictEqual(by.enableALLM, undefined, 'a key the TV lacks is left out');
});
lgs.set('gameGenre', 'FPS', function (r) { assert.strictEqual(r.ok, true); });
lgs.set('gameGenre', 'Racing', function (r) { assert.strictEqual(r.ok, false); });
lgs.set('blackStabilizer', 21, function (r) { assert.strictEqual(r.ok, false); });
lgs.set('blackStabilizer', 15, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(writes.slice(1), [
  { category: 'other', settings: { gameGenre: 'FPS' } },
  { category: 'other', settings: { blackStabilizer: 15 } }
]);
console.log('  ✓ choices and numbers write only values the setting takes');

// 4. Choices and ranges follow what the TV describes; text numbers stay text
stored.sound = { soundMode: 'standard', audioBalance: '0' };
described.sound = [
  { key: 'soundMode', values: { arrayExt: [{ value: 'standard' }, { value: 'movie' }, { value: 'news', visible: false }] } },
  { key: 'audioBalance', values: { min: -50, max: 50 } }
];
lgs.collect(['sound'], function (r) {
  var by = {};
  r.rows.forEach(function (x) { by[x.id] = x; });
  assert.deepEqual(by.soundMode.choices.map(function (c) { return c.value; }), ['standard', 'movie']);
  assert.strictEqual(by.audioBalance.value, 0);
});
lgs.set('audioBalance', -5, function (r) { assert.strictEqual(r.ok, true); });
assert.deepEqual(writes[writes.length - 1], { category: 'sound', settings: { audioBalance: '-5' } });
console.log('  ✓ choices are the TV\'s own, and numbers kept as text are written as text');

// A value set outside the list is kept, by its own name
stored.sound.soundOutput = 'wisa_speaker';
lgs.collect(['sound'], function (r) {
  var out = r.rows.filter(function (x) { return x.id === 'soundOutput'; })[0];
  var last = out.choices[out.choices.length - 1];
  assert.deepEqual(last, { value: 'wisa_speaker', label: 'wisa_speaker' });
  assert.strictEqual(out.value, 'wisa_speaker');
});
console.log('  ✓ a value outside the list is shown by its own name');

// A per-port row gives way where the TV has the one setting, and a setting
// the TV has greyed out comes back marked so
stored.other = { uhdDeepColor: 'off', uhdDeepColorHDMI1: 'off' };
described.other = [{ key: 'uhdDeepColor', values: { arrayExt: [{ value: 'off' }, { value: '4k' }] }, ui: { active: false } }];
lgs.collect(['hdmi'], function (r) {
  var ids = r.rows.map(function (x) { return x.id; });
  assert.ok(ids.indexOf('deepColor') !== -1);
  assert.strictEqual(ids.indexOf('deepColorHDMI1'), -1, 'the per-port key is not shown beside the one setting');
  assert.strictEqual(r.rows[ids.indexOf('deepColor')].active, false);
});
stored.other = { uhdDeepColorHDMI1: 'on' };
described.other = [];
lgs.collect(['hdmi'], function (r) {
  assert.deepEqual(r.rows.map(function (x) { return x.id; }), ['deepColorHDMI1']);
  assert.strictEqual(r.rows[0].active, undefined);
});
console.log('  ✓ per-port rows give way to the one setting, and greyed-out settings say so');

// A greyed-out setting is not written, although the TV would store it
greyed.inputAudioFormatHDMI1 = true;
var before = writes.length;
lgs.set('audioFormatHDMI1', 'pcm', function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, before);
});
greyed = {};
console.log('  ✓ a greyed-out setting is refused rather than written');

// 5. Only rows in the table can be written
lgs.set('systemPin', true, function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, 4);
  console.log('  ✓ anything outside the table is refused');
});

console.log('ALL test-lgsettings.js assertions passed!\n');
