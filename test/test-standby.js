/**
 * test/test-standby.js - A switched-off TV that does not go to sleep
 */

var assert = require('assert');
var standby = require('../server/lib/standby');

console.log('Running test-standby.js ...');

var T0 = 1000000;
var LATER = T0 + standby.STUCK_AFTER_MS + 1000;
function stats(extra) {
  var s = { powerState: { raw: 'Active Standby' }, alwaysReady: false, lifeOnScreen: 'off',
            oled: { comp_status: 'Idle', refresher_status: 'Idle' } };
  for (var k in extra) s[k] = extra[k];
  return s;
}

// 1. Awake past the limit with nothing holding it
standby.noteState('Active', T0 - 5000);
standby.noteState('Active Standby', T0);
assert.strictEqual(standby.isStuck(stats({}), T0 + 60000), false, 'a TV just switched off is not stuck');
assert.strictEqual(standby.isStuck(stats({}), LATER), true);
console.log('  ✓ flagged once the TV has been awake past the limit');

// 2. Things that keep it awake on purpose
assert.strictEqual(standby.isStuck(stats({ alwaysReady: true }), LATER), false, 'Always-on');
assert.strictEqual(standby.isStuck(stats({ lifeOnScreen: 'alwaysReady' }), LATER), false, 'Always Ready');
assert.strictEqual(standby.isStuck(stats({ oled: { comp_status: 'Running' } }), LATER), false, 'compensation');
assert.strictEqual(standby.isStuck(stats({ oled: { refresher_status: 'Running' } }), LATER), false, 'pixel refresher');
console.log('  ✓ Always-on, Always Ready and panel maintenance are not flagged');

// 3. Switching on clears it, and the count starts again at the next switch-off
standby.noteState('Active', LATER);
assert.strictEqual(standby.isStuck(stats({ powerState: { raw: 'Active' } }), LATER + 1000), false);
standby.noteState('Active Standby', LATER + 2000);
assert.strictEqual(standby.isStuck(stats({}), LATER + 3000), false);
console.log('  ✓ switching on clears it');

console.log('ALL test-standby.js assertions passed!\n');
