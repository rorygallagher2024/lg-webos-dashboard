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

// 1. Only the rows the TV has come back, one read per category
lgs.collect(function (r) {
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

// 3. Only rows in the table can be written
lgs.set('systemPin', true, function (r) {
  assert.strictEqual(r.ok, false);
  assert.strictEqual(writes.length, 1);
  console.log('  ✓ anything outside the table is refused');
});

console.log('ALL test-lgsettings.js assertions passed!\n');
