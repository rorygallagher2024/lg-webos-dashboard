/**
 * test/run-all.js - Offline test runner
 *
 * Runs every test suite under test/ and exits non-zero if any assertion fails.
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

var passed = 0;
var failed = 0;
var current = 0;

function runNext() {
  if (current >= suites.length) {
    console.log('─────────────────────────');
    console.log(passed + ' suite(s) passed, ' + failed + ' suite(s) failed.');
    process.exit(failed > 0 ? 1 : 0);
    return;
  }

  var suite = suites[current];
  current++;
  var suitePath = path.join(testDir, suite);

  var proc = child.fork(suitePath, [], { silent: true });

  var stdout = '';
  var stderr = '';
  proc.stdout.on('data', function (d) { stdout += d; });
  proc.stderr.on('data', function (d) { stderr += d; });

  proc.on('close', function (code) {
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    if (code === 0) {
      passed++;
    } else {
      console.error('FAIL: ' + suite + ' exited with code ' + code);
      failed++;
    }

    runNext();
  });
}

console.log('Running ' + suites.length + ' test suite(s)...\n');
runNext();
