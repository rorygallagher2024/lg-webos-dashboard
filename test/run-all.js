/**
 * test/run-all.js - Offline test runner
 *
 * Runs every test suite under test/, all at once, and exits non-zero if any
 * assertion fails.
 * Each suite may contain async tests; the runner waits for process.exit or an
 * uncaught exception to determine the outcome.
 *
 * Usage:  node test/run-all.js
 */

var child = require('child_process');
var path = require('path');
var fs = require('fs');

var testDir = __dirname;
var suites = fs.readdirSync(testDir)
  .filter(function (f) { return /^test-.*\.js$/.test(f); })
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in ' + testDir);
  process.exit(1);
}

/*
 * All suites at once: each runs in its own process, with its own temporary
 * files and ports, and the slow ones (the server start-up, MQTT reconnects,
 * the watchdog) spend their time waiting on real timers. Output is held per
 * suite and printed in name order once all have finished.
 */
var results = {};
var left = suites.length;

suites.forEach(function (suite) {
  var proc = child.fork(path.join(testDir, suite), [], { silent: true });
  var out = { stdout: '', stderr: '', code: null };
  proc.stdout.on('data', function (d) { out.stdout += d; });
  proc.stderr.on('data', function (d) { out.stderr += d; });
  proc.on('close', function (code) {
    out.code = code;
    results[suite] = out;
    if (--left === 0) report();
  });
});

function report() {
  var failed = 0;
  suites.forEach(function (suite) {
    var r = results[suite];
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code !== 0) {
      console.error('FAIL: ' + suite + ' exited with code ' + r.code);
      failed++;
    }
  });
  console.log('─────────────────────────');
  console.log((suites.length - failed) + ' suite(s) passed, ' + failed + ' suite(s) failed.');
  process.exit(failed > 0 ? 1 : 0);
}

console.log('Running ' + suites.length + ' test suite(s)...\n');
