/**
 * test/test-tvwebctl.js - The watchdog restarts a wedged server, frees a stuck
 * child and clears a dead server's leftovers, and leaves a healthy one alone
 *
 * Runs server/tvwebctl itself against test/mocks/fake-server.js, with its
 * files in a temporary directory and its timings shortened. Needs Linux's
 * /proc and start-stop-daemon, so it is skipped elsewhere.
 *
 * Strict ES5: runs on node 0.12.
 */
var child = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

console.log('Running test-tvwebctl.js ...');

var hasDaemon = false;
try { child.execSync('command -v start-stop-daemon', { stdio: 'ignore' }); hasDaemon = true; } catch (e) {}
if (process.platform !== 'linux' || !hasDaemon) {
  console.log('  - skipped: needs Linux with start-stop-daemon');
  console.log('ALL test-tvwebctl.js assertions passed!\n');
  process.exit(0);
}

var dir = path.join(os.tmpdir(), 'tvwebctl-' + process.pid);
fs.mkdirSync(dir);
var CTL = path.join(__dirname, '..', 'server', 'tvwebctl');
var APP = path.join(dir, 'tvweb.js');
fs.writeFileSync(APP, fs.readFileSync(path.join(__dirname, 'mocks', 'fake-server.js')));
var MODE = path.join(dir, 'mode');
var RESTARTS = path.join(dir, 'tvweb.restarts');
var PIDFILE = path.join(dir, 'tvweb.pid');

var env = {};
for (var k in process.env) env[k] = process.env[k];
env.TVWEB_APP = APP;
env.TVWEB_LOG = path.join(dir, 'tvweb.log');
env.TVWEB_PIDFILE = PIDFILE;
env.TVWEB_WATCHPID = path.join(dir, 'tvwebwatch.pid');
env.TVWEB_BEAT = path.join(dir, 'tvweb.beat');
env.TVWEB_RESTARTS = RESTARTS;
env.TVWEB_NODE = process.execPath;
env.TVWEB_CHECK = '2';
env.TVWEB_STALE = '4';
env.TVWEB_STARTUP = '0';
env.TVWEB_STARTUP_STALE = '4';
env.FAKE_MODE = MODE;

function ctl(cmd) { return child.execSync('sh ' + CTL + ' ' + cmd, { env: env, encoding: 'utf8' }); }
function mode(m) { fs.writeFileSync(MODE, m); }
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function serverPid() { return parseInt(read(PIDFILE), 10) || 0; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

function finish(code, why) {
  try { ctl('stop'); } catch (e) {}
  if (why) console.error('  ✗ ' + why + '\n--- restarts ---\n' + read(RESTARTS) + '--- log ---\n' + read(env.TVWEB_LOG).slice(-2000));
  child.execSync('rm -rf ' + dir);
  if (!code) console.log('ALL test-tvwebctl.js assertions passed!\n');
  process.exit(code);
}

function waitFor(what, test, ms, cb) {
  var start = Date.now();
  (function poll() {
    if (test()) return cb();
    if (Date.now() - start > ms) return finish(1, 'timed out after ' + ms + 'ms waiting for ' + what);
    setTimeout(poll, 250);
  })();
}

function after(ms, cb) { setTimeout(cb, ms); }

mode('beat');
ctl('start');
waitFor('the server and its heartbeat', function () { return alive(serverPid()) && read(env.TVWEB_BEAT); }, 10000, function () {
  var first = serverPid();

  // 1. A server that keeps beating is left alone
  after(9000, function () {
    if (read(RESTARTS)) return finish(1, 'a healthy server was restarted');
    if (serverPid() !== first) return finish(1, 'the server pid changed');
    console.log('  ✓ a server that keeps beating is left alone');

    // 2. A frozen server is restarted
    mode('freeze');
    waitFor('the wedge restart', function () { return /event loop wedged/.test(read(RESTARTS)); }, 30000, function () {
      mode('beat');
      waitFor('a new server', function () { return serverPid() && serverPid() !== first && alive(serverPid()); }, 10000, function () {
        if (alive(first)) return finish(1, 'the frozen server was left running');
        console.log('  ✓ a frozen server is restarted after two stale checks');
        var second = serverPid();

        // 3. A child stuck as node is killed and the server carries on
        mode('stuck');
        waitFor('the stuck child to be killed', function () { return /stuck before exec/.test(read(RESTARTS)); }, 20000, function () {
          mode('beat');
          var stuck = parseInt(read(MODE + '.child'), 10);
          after(500, function () {
            if (alive(stuck)) return finish(1, 'the stuck child is still running');
            if (serverPid() !== second || !alive(second)) return finish(1, 'the server was restarted for a stuck child');
            console.log('  ✓ a child stuck as node is killed, and the server carries on');

            // 4. A dead server's leftover copy is cleared before a new one starts
            var leftover = child.spawn(process.execPath, [APP], { env: env, detached: true, stdio: 'ignore' });
            leftover.unref();
            process.kill(second, 'SIGKILL');
            waitFor('the restart after the server died', function () {
              return /process gone/.test(read(RESTARTS)) && serverPid() !== second && alive(serverPid());
            }, 20000, function () {
              after(500, function () {
                if (alive(leftover.pid)) return finish(1, 'the leftover copy is still running');
                console.log('  ✓ a dead server\'s leftover copy is cleared before a new one starts');
                finish(0);
              });
            });
          });
        });
      });
    });
  });
});
