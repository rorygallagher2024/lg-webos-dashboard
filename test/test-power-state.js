/**
 * test/test-power-state.js - Unit tests for power state mapping and display panel safety
 * Strict ES5 for Node 0.12.2 compatibility.
 */

var assert = require('assert');
var stateModule = require('../server/lib/state');
var mqttState = require('../server/lib/mqtt-state');
var ha = require('../server/lib/ha');

// Replicate mapPowerState and POWER_STATES as defined in tvweb.js
var POWER_STATES = {
  'active':          ['On',          true,  true],
  'on':              ['On',          true,  true],
  'screenoff':       ['Screen off',  true,  false],
  'screensaver':     ['Screen Saver',true,  true],
  'activestandby':   ['Standby',     false, false],
  'standby':         ['Standby',     false, false],
  'suspend':         ['Standby',     false, false],
  'preparesuspend':  ['Standby',     false, false],
  'requestpoweroff': ['Off',         false, false],
  'poweroff':        ['Off',         false, false],
  'off':             ['Off',         false, false],
  'prepared':        ['Starting up', true,  false],
  'processing':      ['Standby',     false, false]
};

function mapPowerState(raw) {
  var key = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  var m = POWER_STATES[key];
  if (m) return { raw: raw, label: m[0], systemOn: m[1], screenOn: m[2] };
  return { raw: raw || null, label: raw || 'Unknown', systemOn: false, screenOn: false };
}

// ---------------------------------------------------------------- mapPowerState
console.log('Running test-power-state.js ...');

// 1. Active states
assert.strictEqual(mapPowerState('Active').screenOn, true);
assert.strictEqual(mapPowerState('Active').systemOn, true);
assert.strictEqual(mapPowerState('active').screenOn, true);
assert.strictEqual(mapPowerState('On').screenOn, true);
assert.strictEqual(mapPowerState('Screen Saver').screenOn, true);
assert.strictEqual(mapPowerState('screensaver').screenOn, true);
console.log('  ✓ active and screensaver states have screenOn=true');

// 2. Screen off while running
assert.strictEqual(mapPowerState('Screen Off').screenOn, false);
assert.strictEqual(mapPowerState('Screen Off').systemOn, true);
console.log('  ✓ Screen Off has screenOn=false and systemOn=true');

// 3. Standby, suspend, and compensation completion transitions
var nonScreenStates = [
  'Active Standby',
  'active_standby',
  'Standby',
  'standby',
  'Suspend',
  'suspend',
  'Prepare Suspend',
  'preparesuspend',
  'Request Power Off',
  'requestpoweroff',
  'Power Off',
  'poweroff',
  'Off',
  'off',
  'Processing',
  'processing',
  'Starting up',
  'prepared'
];

for (var i = 0; i < nonScreenStates.length; i++) {
  var st = mapPowerState(nonScreenStates[i]);
  assert.strictEqual(st.screenOn, false, 'Expected screenOn=false for ' + nonScreenStates[i]);
}
console.log('  ✓ all standby, suspend, and transitional states have screenOn=false');

// 4. Unknown / null / undefined states default safely to off
assert.strictEqual(mapPowerState(null).screenOn, false);
assert.strictEqual(mapPowerState(null).systemOn, false);
assert.strictEqual(mapPowerState(undefined).screenOn, false);
assert.strictEqual(mapPowerState(undefined).systemOn, false);
assert.strictEqual(mapPowerState('').screenOn, false);
assert.strictEqual(mapPowerState('Unknown').screenOn, false);
assert.strictEqual(mapPowerState('something_unknown').screenOn, false);
console.log('  ✓ null, undefined, and unknown states default safely to screenOn=false');

// ---------------------------------------------------------------- mqtt-state guard
var published = {};
var mockMqtt = {
  publish: function (topic, val) {
    published[topic] = val;
  }
};

var stateMgr = new stateModule.StateManager();
var mqtt = mqttState.init({
  client: mockMqtt,
  prefix: 'lgtv',
  legacyScreenTopic: 'lgtv/state/screen'
});
mqtt.attach(stateMgr);

// When system is active and screen is on:
stateMgr.update('power', 'systemOn', true);
stateMgr.update('power', 'screenOn', true);
assert.strictEqual(published['lgtv/state/screen'], 'ON');
console.log('  ✓ mqtt-state publishes ON when system is on and screen is on');

// When TV enters Active Standby:
stateMgr.update('power', 'systemOn', false);
stateMgr.update('power', 'screenOn', false);
assert.strictEqual(published['lgtv/state/screen'], 'OFF');
console.log('  ✓ mqtt-state publishes OFF when entering Active Standby');

// Even if a transient event attempts to set screenOn=true while systemOn=false:
stateMgr.update('power', 'screenOn', true);
assert.strictEqual(published['lgtv/state/screen'], 'OFF');
console.log('  ✓ mqtt-state suppresses ON and keeps OFF while systemOn is false');

// ---------------------------------------------------------------- ha entity naming
var oledEntities = ha.buildEntities({ isOled: true });
var lcdEntities = ha.buildEntities({ isOled: false });
var defaultEntities = ha.buildEntities({});

function findDisplayPanel(list) {
  for (var j = 0; j < list.length; j++) {
    if (list[j].id === 'display_panel') return list[j];
  }
  return null;
}

var oledPanel = findDisplayPanel(oledEntities);
var lcdPanel = findDisplayPanel(lcdEntities);
var defPanel = findDisplayPanel(defaultEntities);

assert(oledPanel, 'display_panel entity missing for OLED');
assert(lcdPanel, 'display_panel entity missing for LCD');
assert(defPanel, 'display_panel entity missing for default');

assert.strictEqual(oledPanel.payload.name, 'OLED Display Panel');
assert.strictEqual(lcdPanel.payload.name, 'Display Panel');
assert.strictEqual(defPanel.payload.name, 'OLED Display Panel');
console.log('  ✓ ha entity name is "OLED Display Panel" on OLED and "Display Panel" on LCD');

console.log('ALL test-power-state.js assertions passed!');
