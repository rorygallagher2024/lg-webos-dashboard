/**
 * test/test-luna.js - A luna-send child that dies before answering is run once more
 */

var assert = require('assert');
var child = require('child_process');

var runs = [];
var script = [];
// The module keeps its own reference to execFile, so this has to be in place
// before it is required.
var startedAt = [];
child.execFile = function (file, args, opts, cb) {
  runs.push(args[args.length - 2]);
  startedAt.push(Date.now());
  var next = script.shift();
  process.nextTick(function () { cb(next.err || null, next.out || ''); });
};

var EventEmitter = require('events').EventEmitter;
var spawnedAt = [];
child.spawn = function () {
  spawnedAt.push(Date.now());
  var c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = function () {};
  return c;
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

      // 4. Calls made together start one at a time, spaced out just after start
      runs = []; startedAt = [];
      script = [{ out: '{}' }, { out: '{}' }];
      var done = 0;
      var both = function () {
        if (++done < 2) return;
        assert.strictEqual(runs.length, 2);
        assert.ok(startedAt[1] - startedAt[0] >= 130, 'second start ' + (startedAt[1] - startedAt[0]) + 'ms after the first');
        console.log('  ✓ two calls made together start 150ms apart after start-up');

        // 5. Subscriptions wait their turn with the calls
        runs = []; startedAt = []; spawnedAt = [];
        script = [{ out: '{}' }];
        var subA = new luna.Subscription('com.webos.audio/getVolume', { subscribe: true }, null, {});
        var subB = new luna.Subscription('com.webos.service.tvpower/power/getPowerState', { subscribe: true }, null, {});
        subA.start(); subB.start();
        luna.call('com.webos.service.settings/getSystemSettings', {}, function () {});
        setTimeout(function () {
          var starts = spawnedAt.concat(startedAt).sort();
          assert.strictEqual(starts.length, 3);
          assert.ok(starts[1] - starts[0] >= 130 && starts[2] - starts[1] >= 130,
                    'starts ' + (starts[1] - starts[0]) + 'ms and ' + (starts[2] - starts[1]) + 'ms apart');
          subA.stop(); subB.stop();
          console.log('  ✓ subscriptions start in turn with calls, spaced the same');

          // 6. A clock stepped back, as on resume from standby, does not hold starts up
          var realNow = Date.now;
          Date.now = function () { return realNow() - 600000; };
          runs = [];
          script = [{ out: '{}' }];
          var t0 = realNow();
          // Fails rather than hangs: a stalled queue never calls back.
          var guard = setTimeout(function () {
            console.error('  ✗ a call made after the clock stepped back never started');
            process.exit(1);
          }, 2000);
          luna.call('com.webos.audio/getVolume', {}, function () {
            clearTimeout(guard);
            Date.now = realNow;
            var waited = realNow() - t0;
            assert.ok(waited < 1000, 'a call waited ' + waited + 'ms after the clock stepped back');
            console.log('  ✓ a clock stepped back does not hold starts up');
            console.log('ALL test-luna.js assertions passed!\n');
          });
        }, 800);
      };
      luna.call('com.webos.service.tvpower/power/getPowerState', {}, both);
      luna.call('com.webos.audio/getVolume', {}, both);
    });
  });
});
