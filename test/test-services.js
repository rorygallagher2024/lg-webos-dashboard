/**
 * test/test-services.js - Unit tests for background service debloating subsystem
 */

var assert = require('assert');
var path = require('path');
var services = require('../server/lib/services');

console.log('Running test-services.js ...');

// 1. CATALOG integrity
(function testCatalogIntegrity() {
  assert.strictEqual(Array.isArray(services.CATALOG), true);
  assert.strictEqual(services.CATALOG.length >= 8, true);

  var ids = {};
  for (var i = 0; i < services.CATALOG.length; i++) {
    var item = services.CATALOG[i];
    assert.strictEqual(typeof item.id, 'string', 'item id must be string');
    assert.strictEqual(typeof item.title, 'string', 'item title must be string');
    assert.strictEqual(typeof item.desc, 'string', 'item desc must be string');
    assert.strictEqual(typeof item.badge, 'string', 'item badge must be string');
    assert.strictEqual(!ids[item.id], true, 'item id must be unique: ' + item.id);
    ids[item.id] = true;

    // Must have at least a systemd unit or an upstart job name
    var hasTarget = !!(item.unit || item.upstart);
    assert.strictEqual(hasTarget, true, 'service ' + item.id + ' must declare unit or upstart');
  }

  assert.strictEqual('mycar' in ids, true);
  assert.strictEqual('camera' in ids, true);
  assert.strictEqual('rdxd' in ids, true);
  assert.strictEqual('uploadd' in ids, true);

  console.log('  ✓ CATALOG contains valid debloatable services with metadata');
})();

// 2. Reject unknown service toggle
(function testUnknownServiceToggle() {
  services.toggleService('nonexistent-service', true, function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.indexOf('Unknown service ID') !== -1, true);
    console.log('  ✓ toggleService rejects unknown service IDs');
  });
})();

// 3. getServices returns supported flag and array
(function testGetServicesResponse() {
  services.getServices(function (res) {
    assert.strictEqual(typeof res.ok, 'boolean');
    assert.strictEqual(typeof res.supported, 'boolean');
    assert.strictEqual(Array.isArray(res.services), true);
    console.log('  ✓ getServices produces valid services payload');
  });
})();

console.log('ALL test-services.js assertions passed!\n');
