/*
 * Starts the real server with the TV's file system moved into FAKE_ROOT, for
 * the start-up test. Every path the server uses under /var, /mnt, /media,
 * /proc, /sys, /etc or /home/root is read and written under FAKE_ROOT
 * instead, which the test seeds with mock-env's files. Node 0.12 has no -r,
 * so this runs first and then loads tvweb.js itself.
 *
 * Strict ES5: the test runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');

var ROOT = process.env.FAKE_ROOT;
if (!ROOT) { console.error('FAKE_ROOT not set'); process.exit(2); }

var MOVED = /^\/(var|mnt|media|proc|sys|etc|home\/root)(\/|$)/;
function moved(p) {
  if (typeof p !== 'string' || p.indexOf(ROOT) === 0 || !MOVED.test(p)) return p;
  return path.join(ROOT, p);
}

// Functions taking a path first; rename, link and symlink take two.
var ONE = ['access', 'appendFile', 'chmod', 'chown', 'createReadStream', 'createWriteStream', 'exists',
  'lstat', 'mkdir', 'open', 'readdir', 'readFile', 'readlink', 'realpath', 'rmdir', 'stat', 'truncate',
  'unlink', 'utimes', 'watch', 'watchFile', 'unwatchFile', 'writeFile'];
var TWO = ['rename', 'link', 'symlink'];

function wrap(name, both) {
  [name, name + 'Sync'].forEach(function (fn) {
    var orig = fs[fn];
    if (typeof orig !== 'function') return;
    fs[fn] = function () {
      var a = Array.prototype.slice.call(arguments);
      a[0] = moved(a[0]);
      if (both) a[1] = moved(a[1]);
      return orig.apply(fs, a);
    };
  });
}
ONE.forEach(function (n) { wrap(n, false); });
TWO.forEach(function (n) { wrap(n, true); });

process.argv = [process.argv[0], path.join(__dirname, '..', '..', 'server', 'tvweb.js')]
  .concat(process.argv.slice(2));
require('../../server/tvweb.js');
