/**
 * test/test-screensaver-switch.js - The pause while sam restarts for a
 * screen saver that runs on another runner (Flutter stock on webOS 10)
 */

var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

var restarts = [];
var onMount = function () {};
// The module keeps its own reference to execFile, so this has to be in place
// before it is required.
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/systemctl') restarts.push(args.join(' '));
  if (file === '/bin/mount') onMount();
  process.nextTick(function () { cb(null, '', ''); });
};

// Timers run at once, so the poll and the settle delay need no waiting.
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var polls = 0;
var ssRequests = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    // sam answers with LG's runner until the restart, then not at all for a
    // while, then with ours.
    'com.webos.applicationManager/getAppInfo': function () {
      if (restarts.length === 0) return { returnValue: true, appInfo: { type: 'flutter' } };
      polls++;
      if (polls < 3) return null;
      return { returnValue: true, appInfo: { type: 'qml' } };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.home' },
    'com.webos.service.tvpower/power/turnOnScreenSaver': function () {
      ssRequests++;
      return { returnValue: true };
    },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
env.files['/tmp/tvweb-test/clock.qml'] = 'Item {}';
env.install();
var fs = require('fs');
var realReaddir = fs.readdirSync;
fs.readdirSync = function (p) {
  return p === '/tmp/tvweb-test' ? ['clock.qml'] : realReaddir.apply(fs, arguments);
};

var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensaver-switch.js ...');

screensavers.init({
  luna: env.mockLuna,
  assetPath: function (qml) { return qml === 'screensavers/clock.qml' ? '/tmp/tvweb-test/clock.qml' : null; },
  config: { port: 8080, allowControl: true },
  mapPowerState: function (s) { return { raw: s }; },
  isScreenSaver: function () { return false; }
});

// 1. The stock runner is remembered while LG's screen saver is showing
assert.strictEqual(env.files[STOCK_TYPE_FILE], 'flutter');
assert.strictEqual(screensavers.screensaverList().slowSwitch, true);
assert.strictEqual(screensavers.screensaverList().switching, false);
console.log('  ✓ a Flutter stock screen saver marks switches as slow');

// Nothing is mounted in the mock, so show the staged directory at the app path
// the way the bind mount would.
onMount = function () {
  Object.keys(env.files).forEach(function (k) {
    if (k.indexOf(screensavers.SCREENSAVER_DIR + '/') === 0) {
      env.files[APP + k.slice(screensavers.SCREENSAVER_DIR.length)] = env.files[k];
    }
  });
};

var heldTrigger = null;
var heldSwitch = null;
var realNextTick = process.nextTick;

screensavers.setScreensaver('clock', 'dim', function (r) {
  // 2. Moving off a Flutter stock restarts sam and reports the pause
  assert.strictEqual(restarts.length, 1);
  assert.ok(/restart --no-block sam/.test(restarts[0]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.switching, true);
  console.log('  ✓ switching from a Flutter stock restarts sam and reports it');

  // 3. Nothing may start or change a screen saver until sam is back
  screensavers.trigger(function (t) { heldTrigger = t; });
  screensavers.setScreensaver('stock', 'dim', function (t) { heldSwitch = t; });
  assert.strictEqual(heldTrigger.ok, false);
  assert.ok(/still switching/.test(heldTrigger.error));
  assert.strictEqual(heldSwitch.ok, false);
  assert.strictEqual(ssRequests, 0);
  console.log('  ✓ start and switch requests are refused while sam restarts');

  // 4. It clears once sam answers with the runner now staged
  realNextTick(function waitClear() {
    if (screensavers.switching()) return realNextTick(waitClear);
    assert.ok(polls >= 3, 'cleared before sam came back');
    screensavers.trigger(function (t) {
      assert.strictEqual(t.ok, true);
      assert.strictEqual(ssRequests, 1);
      console.log('  ✓ the pause clears once sam is back with the new runner');
      console.log('ALL test-screensaver-switch.js assertions passed!\n');
      env.restore();
    });
  });
});
