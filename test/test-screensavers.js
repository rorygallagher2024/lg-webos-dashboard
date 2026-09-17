/**
 * test/test-screensavers.js - Unit tests for screensaver subsystem
 */

var assert = require('assert');
var path = require('path');
var mockEnv = require('./mocks/mock-env');

var SCREENSAVER_APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';

// Build a mock env that includes screensaver marker files
var env = mockEnv.createMockEnv({
  files: {
    // no marker => stock mode
  }
});
env.install();

var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensavers.js ...');

// 1. screensaverMode defaults to stock when no marker file exists
(function testModeDefaultsToStock() {
  assert.strictEqual(screensavers.screensaverMode(), 'stock');
  console.log('  ✓ screensaverMode returns stock when marker is absent');
})();

// 2. screensaverMode reads the marker file
(function testModeReadsMarker() {
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-screensaver')] = 'clock';
  assert.strictEqual(screensavers.screensaverMode(), 'clock');

  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-screensaver')] = 'starfield';
  assert.strictEqual(screensavers.screensaverMode(), 'starfield');

  // Invalid mode falls back to stock
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-screensaver')] = 'nonexistent';
  assert.strictEqual(screensavers.screensaverMode(), 'stock');

  // "stock" in the marker also returns stock
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-screensaver')] = 'stock';
  assert.strictEqual(screensavers.screensaverMode(), 'stock');

  console.log('  ✓ screensaverMode reads marker and validates against known screensavers');
})();

// 3. screensaverLevel defaults to dim
(function testLevelDefaultsToDim() {
  // No brightness marker file
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-brightness')] = null;
  assert.strictEqual(screensavers.screensaverLevel(), 'dim');
  console.log('  ✓ screensaverLevel returns dim when brightness marker is absent');
})();

// 4. screensaverLevel reads "bright"
(function testLevelReadsBright() {
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-brightness')] = 'bright';
  assert.strictEqual(screensavers.screensaverLevel(), 'bright');

  // any other value falls back to dim
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-brightness')] = 'unknown';
  assert.strictEqual(screensavers.screensaverLevel(), 'dim');

  console.log('  ✓ screensaverLevel reads bright marker and rejects unknown values');
})();

// 5. screensaverList returns all modes with correct structure
(function testScreensaverList() {
  // Reset to clock mode, dim level
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-screensaver')] = 'clock';
  env.files[path.join(SCREENSAVER_APP_DIR, '.tvweb-brightness')] = null;

  // Provide assetPath that resolves for clock and starfield but not fireworks
  screensavers.init({
    luna: env.mockLuna,
    assetPath: function (qml) {
      if (qml === 'screensavers/clock.qml') return '/tmp/clock.qml';
      if (qml === 'screensavers/starfield.qml') return '/tmp/starfield.qml';
      return null;
    },
    config: { port: 8080, allowControl: true },
    injectKey: null,
    KEY_BACK: null,
    mapPowerState: null,
    isScreenSaver: null
  });

  var list = screensavers.screensaverList();
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.current, 'clock');
  assert.strictEqual(list.level, 'dim');
  assert.strictEqual(list.writable, true);
  assert.ok(Array.isArray(list.modes));

  // stock is always available
  var stock = list.modes.filter(function (m) { return m.id === 'stock'; })[0];
  assert.ok(stock, 'stock mode must exist');
  assert.strictEqual(stock.available, true);
  assert.strictEqual(stock.active, false);

  // clock is active and available
  var clock = list.modes.filter(function (m) { return m.id === 'clock'; })[0];
  assert.ok(clock, 'clock mode must exist');
  assert.strictEqual(clock.active, true);
  assert.strictEqual(clock.available, true);

  // fireworks is NOT available (assetPath returns null)
  var fireworks = list.modes.filter(function (m) { return m.id === 'fireworks'; })[0];
  assert.ok(fireworks, 'fireworks mode must exist');
  assert.strictEqual(fireworks.available, false);

  console.log('  ✓ screensaverList returns all modes with correct active/available flags');
})();

// 6. screensaverList reflects writable=false when allowControl is not set
(function testListNotWritable() {
  screensavers.init({
    luna: env.mockLuna,
    assetPath: null,
    config: { port: 8080 },
    injectKey: null,
    KEY_BACK: null,
    mapPowerState: null,
    isScreenSaver: null
  });

  var list = screensavers.screensaverList();
  assert.strictEqual(list.writable, false);
  console.log('  ✓ screensaverList reports writable=false without allowControl');
})();

// 7. SCREENSAVERS catalog has expected entries
(function testCatalog() {
  var ids = Object.keys(screensavers.SCREENSAVERS);
  assert.ok(ids.indexOf('stock') !== -1, 'catalog must include stock');
  assert.ok(ids.indexOf('clock') !== -1, 'catalog must include clock');
  assert.ok(ids.indexOf('starfield') !== -1, 'catalog must include starfield');
  assert.ok(ids.indexOf('fireworks') !== -1, 'catalog must include fireworks');
  assert.ok(ids.indexOf('vitals') !== -1, 'catalog must include vitals');
  assert.strictEqual(ids.length, 5, 'catalog must have exactly 5 entries');

  // Each non-stock entry must have a qml path
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] === 'stock') continue;
    assert.ok(screensavers.SCREENSAVERS[ids[i]].qml, ids[i] + ' must have a qml path');
  }

  console.log('  ✓ SCREENSAVERS catalog has 5 expected entries with QML paths');
})();

// 8. trigger returns error when luna is not available
(function testTriggerNoLuna() {
  screensavers.init({
    luna: null,
    assetPath: null,
    config: {},
    injectKey: null,
    KEY_BACK: null,
    mapPowerState: null,
    isScreenSaver: null
  });

  screensavers.trigger(function (result) {
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.indexOf('luna') !== -1 || result.error.indexOf('not available') !== -1);
    console.log('  ✓ trigger returns error when luna bus is unavailable');
    console.log('ALL test-screensavers.js assertions passed!\n');
    env.restore();
  });
})();
