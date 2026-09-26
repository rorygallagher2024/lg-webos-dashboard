/*
 * A stand-in server for test-tvwebctl.js. Does what the file named by
 * FAKE_MODE says, checked twice a second:
 *   beat   write the heartbeat, as the server does
 *   freeze stop writing it, as a wedged server does
 *   stuck  start one child that stays node, as a child stuck before exec
 *          does, and keep beating
 *
 * Strict ES5: the test runs on node 0.12.
 */
var fs = require('fs');
var child = require('child_process');

var spawned = false;
setInterval(function () {
  var mode = 'beat';
  try { mode = fs.readFileSync(process.env.FAKE_MODE, 'utf8').trim(); } catch (e) {}
  if (mode === 'freeze') return;
  if (mode === 'stuck' && !spawned) {
    spawned = true;
    var c = child.spawn(process.execPath, ['-e', 'setInterval(function () {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_MODE + '.child', String(c.pid));
  }
  fs.writeFileSync(process.env.TVWEB_BEAT, String(Math.floor(Date.now() / 1000)));
}, 500);
