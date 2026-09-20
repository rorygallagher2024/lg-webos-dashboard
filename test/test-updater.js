/**
 * test/test-updater.js - Unit tests for updater subsystem and API payload
 */

var assert = require('assert');
var path = require('path');
var updater = require('../server/lib/updater');

console.log('Running test-updater.js ...');

// 1. Version comparisons
(function testVerNewer() {
  assert.strictEqual(updater.verNewer('0.40.0', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('0.39.2', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('1.0.0', '0.39.1'), true);
  assert.strictEqual(updater.verNewer('0.39.1', '0.39.1'), false);
  assert.strictEqual(updater.verNewer('0.39.0', '0.39.1'), false);
  assert.strictEqual(updater.verNewer('v0.40.0', 'v0.39.1'), true);
  console.log('  ✓ verNewer correctly evaluates semver precedence');
})();

// 2. Initial state and updateSummary structure
(function testUpdateSummaryStructure() {
  updater.init({
    config: { allowControl: true, update: { check: true } },
    version: '0.39.1',
    installDir: path.resolve(__dirname, '..')
  });

  var s = updater.updateSummary();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.installed, '0.39.1');
  assert.strictEqual(typeof s.state, 'string');
  assert.strictEqual(typeof s.available, 'boolean');
  assert.strictEqual(s.autoCheck, true);
  assert.strictEqual(s.writable, true);
  assert.strictEqual('latest' in s, true);
  assert.strictEqual('client' in s, true);
  assert.strictEqual('rollbackTo' in s, true);
  assert.strictEqual('checkedMs' in s, true);
  console.log('  ✓ updateSummary contains all expected fields for dashboard rows');
})();

// 3. Read-only permissions reflect writable flag
(function testReadOnlyWritableFlag() {
  updater.init({
    config: { allowControl: false },
    version: '0.39.1'
  });

  var s = updater.updateSummary();
  assert.strictEqual(s.writable, false);
  console.log('  ✓ updateSummary accurately reports writable=false when controls are disabled');
})();

console.log('ALL test-updater.js assertions passed!\n');
