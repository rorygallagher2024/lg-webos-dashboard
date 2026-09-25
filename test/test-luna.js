/**
 * test/test-luna.js - A luna-send child that dies before answering is run once more
 */

var assert = require('assert');
var child = require('child_process');

var runs = [];
var script = [];
// The module keeps its own reference to execFile, so this has to be in place
// before it is required.
child.execFile = function (file, args, opts, cb) {
  runs.push(args[args.length - 2]);
  var next = script.shift();
  process.nextTick(function () { cb(next.err || null, next.out || ''); });
};

var luna = require('../server/lib/luna');
var aborted = function () { var e = new Error('Command failed'); e.signal = 'SIGABRT'; e.killed = false; return e; };
var timedOut = function () { var e = new Error('Command failed'); e.signal = 'SIGTERM'; e.killed = true; return e; };

console.log('Running test-luna.js ...');
var errors = [];
console.error = function (m) { errors.push(String(m)); };

// 1. A child that aborted is run again, and the second answer is used
script = [{ err: aborted() }, { out: '{"returnValue":true,"modelName":"50UP81006LR"}' }];
luna.call('com.webos.service.tv.systemproperty/getSystemProperties', { keys: ['modelName'] }, function (r) {
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(r && r.modelName, '50UP81006LR');
  assert.ok(/died \(SIGABRT\) before answering, trying once more/.test(errors[0]));
  console.log('  ✓ an aborted call runs once more and returns the second answer');

  // 2. Only once: a second abort is given up on
  runs = []; errors = [];
  script = [{ err: aborted() }, { err: aborted() }];
  luna.call('com.webos.service.tvpower/power/getPowerState', {}, function (r2) {
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(r2, null);
    assert.ok(/giving up/.test(errors[1]));
    console.log('  ✓ a second abort is not retried');

    // 3. Our own timeout is not a reason to run it again
    runs = []; errors = [];
    script = [{ err: timedOut() }];
    luna.call('com.webos.service.tvpower/power/getPowerState', {}, function (r3) {
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(r3, null);
      assert.strictEqual(errors.length, 0);
      console.log('  ✓ a call stopped by the timeout is not retried');
      console.log('ALL test-luna.js assertions passed!\n');
    });
  });
});
