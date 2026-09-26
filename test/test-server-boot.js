/**
 * test/test-server-boot.js - The whole server starts, keeps answering and
 * keeps publishing, against a TV that answers and one that misbehaves
 *
 * Runs server/tvweb.js as its own process, with the TV's files in a temporary
 * root (test/mocks/boot-server.js), LG's luna-send replaced by
 * test/mocks/fake-luna-send.js, and an MQTT broker faked here. Each phase
 * checks that the dashboard answers promptly throughout, the heartbeat is
 * written, telemetry keeps reaching the broker, and SIGTERM stops the server
 * cleanly. The phases run side by side; BOOT_TEST_SECS sets how long each
 * runs (default 15, seven telemetry rounds).
 *
 * Strict ES5: runs on node 0.12, the B8's version.
 */
var child = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');

var SECS = +process.env.BOOT_TEST_SECS || 15;
var mockFiles = require('./mocks/mock-env').createMockEnv().files;
var FAKE_LUNA = path.join(__dirname, 'mocks', 'fake-luna-send.js');
fs.chmodSync(FAKE_LUNA, 493); // 0755

console.log('Running test-server-boot.js ...');

function mkdirp(d) {
  if (fs.existsSync(d)) return;
  mkdirp(path.dirname(d));
  fs.mkdirSync(d);
}

function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

function freePort(cb) {
  var s = net.createServer();
  s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { cb(p); }); });
}

function bufFrom(bytes) {
  return (typeof Buffer.from === 'function') ? Buffer.from(bytes) : new Buffer(bytes);
}

function bufAlloc(n) {
  return (typeof Buffer.alloc === 'function') ? Buffer.alloc(n) : new Buffer(n);
}

// ---- a broker that answers CONNECT, SUBSCRIBE and PINGREQ, and logs PUBLISH ----
function Broker(cb) {
  var self = this;
  self.published = [];
  self.disconnects = 0;
  self.server = net.createServer(function (sock) {
    var buf = bufAlloc(0);
    sock.on('error', function () {});
    sock.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        var mult = 1, len = 0, idx = 1, digit;
        do {
          if (idx >= buf.length) return;
          digit = buf[idx++]; len += (digit & 127) * mult; mult *= 128;
        } while (digit & 128);
        if (buf.length < idx + len) return;
        var type = buf[0] >> 4, body = buf.slice(idx, idx + len);
        buf = buf.slice(idx + len);
        if (type === 1) sock.write(bufFrom([0x20, 2, 0, 0]));
        else if (type === 8) sock.write(bufFrom([0x90, 3, body[0], body[1], 0]));
        else if (type === 12) sock.write(bufFrom([0xd0, 0]));
        else if (type === 14) self.disconnects++;
        else if (type === 3) {
          var tl = (body[0] << 8) | body[1];
          self.published.push({ topic: body.slice(2, 2 + tl).toString(), at: Date.now() });
        }
      }
    });
  });
  self.server.listen(0, '127.0.0.1', function () { self.port = self.server.address().port; cb(); });
}
Broker.prototype.last = function (re) {
  for (var i = this.published.length - 1; i >= 0; i--) if (re.test(this.published[i].topic)) return this.published[i];
  return null;
};

function get(port, p, cb) {
  var t0 = Date.now(), done = false;
  var req = http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
    var body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () { if (!done) { done = true; cb(res.statusCode, body, Date.now() - t0); } });
  });
  req.setTimeout(15000, function () { req.abort(); });
  req.on('error', function () { if (!done) { done = true; cb(0, '', Date.now() - t0); } });
}

function waitFor(what, test, ms, cb, fail) {
  var start = Date.now();
  (function poll() {
    if (test()) return cb();
    if (Date.now() - start > ms) return fail('timed out after ' + ms + 'ms waiting for ' + what);
    setTimeout(poll, 200);
  })();
}

function phase(name, chaos, next) {
  var root = path.join(os.tmpdir(), 'tvweb-boot-' + process.pid + '-' + (chaos ? 'chaos' : 'steady'));
  Object.keys(mockFiles).forEach(function (f) {
    if (mockFiles[f] === null) return;
    mkdirp(path.dirname(path.join(root, f)));
    fs.writeFileSync(path.join(root, f), mockFiles[f]);
  });
  mkdirp(path.join(root, 'var/run'));
  mkdirp(path.join(root, 'var/luna/preferences'));
  fs.writeFileSync(path.join(root, 'var/luna/preferences/paneltype_oled'), '');
  mkdirp(path.join(root, 'var/lib/tvweb'));

  var broker = new Broker(function () {
    freePort(function (port) {
      var cfg = path.join(root, 'var/lib/tvweb/config.json');
      fs.writeFileSync(cfg, JSON.stringify({
        port: port, host: '127.0.0.1',
        mqtt: { enabled: true, host: '127.0.0.1', port: broker.port, topicPrefix: 'boot', telemetryIntervalMs: 2000 }
      }));
      var env = {};
      for (var k in process.env) env[k] = process.env[k];
      env.FAKE_ROOT = root;
      env.TVWEB_LUNA_SEND = FAKE_LUNA;
      if (chaos) env.FAKE_LUNA_CHAOS = '1';

      var out = '';
      var srv = child.spawn(process.execPath, [path.join(__dirname, 'mocks', 'boot-server.js'), '--config', cfg], { env: env });
      srv.stdout.on('data', function (d) { out += d; });
      srv.stderr.on('data', function (d) { out += d; });
      var exited = null;
      srv.on('exit', function (code, sig) { exited = { code: code, signal: sig }; });
      // Never leave a server behind, however the test ends.
      process.on('exit', function () { if (!exited) try { srv.kill('SIGKILL'); } catch (e) {} });

      var stopping = false;
      function fail(why) {
        if (stopping) return;
        console.error('  ✗ ' + name + ': ' + why + '\n--- server output ---\n' + out.slice(-4000));
        try { srv.kill('SIGKILL'); } catch (e) {}
        process.exit(1);
      }

      var up = false;
      var tryUp = function () { get(port, '/api/stats', function (code) { if (code === 200) up = true; }); };
      var upTimer = setInterval(tryUp, 500);
      waitFor('the dashboard to answer', function () { return up || exited; }, 30000, function () {
        clearInterval(upTimer);
        if (exited) return fail('server exited at start: ' + JSON.stringify(exited));
        var beat = path.join(root, 'var/run/tvweb.beat');
        waitFor('the heartbeat', function () { return fs.existsSync(beat); }, 5000, function () {
          waitFor('telemetry at the broker', function () { return broker.last(/^boot\/telemetry$/); }, 20000, function () {
            waitFor('discovery at the broker', function () { return broker.last(/^homeassistant\/.*\/config$/); }, 20000, function () {

            /*
             * Steady use: the dashboard asked once a second, telemetry every 2s.
             * Stats wait on the TV, and a TV call that never answers is cut off
             * at 3.5s, so a misbehaving TV slows them. The page itself asks the
             * TV nothing: a slow answer there means the server is stuck.
             */
            var statsLimit = chaos ? 12000 : 4000;
            // A misbehaving TV slows telemetry without stopping it: LG's settings
            // are read a group at a time, and each call that never answers is
            // cut off at 3.5s. CI on node 8.12 saw a 12s gap.
            var gapLimit = chaos ? 25000 : 12000;
            var until = Date.now() + SECS * 1000, worst = 0, worstPage = 0, pending = false;
            var probe = setInterval(function () {
              if (exited) { clearInterval(probe); return fail('server exited: ' + JSON.stringify(exited)); }
              if (pending) return;
              pending = true;
              get(port, '/api/stats', function (code, body, ms) {
                pending = false;
                if (code !== 200) { clearInterval(probe); return fail('dashboard answered ' + code + ' after ' + ms + 'ms'); }
                worst = Math.max(worst, ms);
                get(port, '/', function (pc, pb, pms) {
                  if (stopping) return;
                  if (pc !== 200 || pms > 2000) fail('the page answered ' + pc + ' after ' + pms + 'ms');
                  worstPage = Math.max(worstPage, pms);
                });
                var t = broker.last(/^boot\/telemetry$/);
                if (Date.now() - t.at > gapLimit) { clearInterval(probe); return fail('no telemetry for ' + Math.round((Date.now() - t.at) / 1000) + 's'); }
                if (Date.now() < until) return;
                clearInterval(probe);
                if (worst >= statsLimit) return fail('slowest stats answer ' + worst + 'ms');
                console.log('  ✓ ' + name + ': answered for ' + SECS + 's (slowest stats ' + worst + 'ms, page ' +
                            worstPage + 'ms), telemetry kept flowing');

                stopping = true;
                srv.kill('SIGTERM');
                waitFor('the server to stop', function () { return exited; }, 5000, function () {
                  if (exited.code !== 0) { stopping = false; return fail('exit ' + JSON.stringify(exited)); }
                  if (broker.disconnects < 1) { stopping = false; return fail('MQTT was not disconnected cleanly'); }
                  console.log('  ✓ ' + name + ': stopped cleanly on SIGTERM');
                  broker.server.close();
                  rmrf(root);
                  next();
                }, fail);
              });
            }, 1000);
          }, fail);
        }, fail);
      }, fail);
    }, fail);
    });
  });
}

var phasesLeft = 2;
function phaseDone() {
  if (--phasesLeft) return;
  console.log('ALL test-server-boot.js assertions passed!\n');
  process.exit(0);
}
phase('steady TV', false, phaseDone);
phase('unreliable TV', true, phaseDone);
