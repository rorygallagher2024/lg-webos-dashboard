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
lgs.init({
  lunaCached: function (uri, payload, ttl, cb) { reads++; cb({ returnValue: true, settings: stored[payload.category] || {} }); },
  luna: function (uri, payload, cb) { writes.push(payload); cb({ returnValue: true }); },
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

// 4. Only rows in the table can be written
lgs.set('systemPin', true, function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, 3);
  console.log('  ✓ anything outside the table is refused');
});

console.log('ALL test-lgsettings.js assertions passed!\n');
