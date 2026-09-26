/**
 * test/test-mqtt.js - The client reconnects to a broker that stopped answering
 */

var assert = require('assert');
var net = require('net');
var MiniMQTT = require('../server/lib/mqtt');

console.log('Running test-mqtt.js ...');

// A broker that answers CONNECT and nothing else, counting connections.
var connects = 0;
var server = net.createServer(function (sock) {
  sock.on('data', function (d) {
    if ((d[0] >> 4) === 1) {
      connects++;
      sock.write(MiniMQTT.toBuffer([0x20, 0x02, 0x00, 0x00])); // CONNACK
    }
  });
  sock.on('error', function () {});
});

function waitFor(what, test, ms, cb) {
  var start = Date.now();
  (function poll() {
    if (test()) return cb();
    if (Date.now() - start > ms) { console.error('  ✗ timed out waiting for ' + what); process.exit(1); }
    setTimeout(poll, 50);
  })();
}

server.listen(0, '127.0.0.1', function () {
  var port = server.address().port;
  var client = new MiniMQTT({ host: '127.0.0.1', port: port, clientId: 't', will: { topic: 's', payload: 'offline', retain: true } });
  client.on('error', function () {});
  client.connect();

  waitFor('first connect', function () { return client.connected; }, 3000, function () {
    // 1. A close the broker never acknowledges is forced, and the client connects again
    client.client.end = function () {};
    client.setWill('asleep');
    waitFor('reconnect after a stuck close', function () { return connects === 2 && client.connected; }, 6000, function () {
      console.log('  ✓ a close left hanging is forced after a few seconds');

      // 2. A broker silent since before the last ping is dropped and reconnected
      var realNow = Date.now;
      var realSetInterval = global.setInterval;
      var ping = null;
      global.setInterval = function (fn) { ping = fn; return 0; };
      client.client.destroy();   // reconnects, and the new CONNACK captures the ping timer
      waitFor('reconnect', function () { return connects === 3 && client.connected && ping; }, 8000, function () {
        global.setInterval = realSetInterval;
        Date.now = function () { return realNow() + 60000; };
        ping();
        Date.now = realNow;
        waitFor('reconnect after silence', function () { return connects === 4 && client.connected; }, 8000, function () {
          console.log('  ✓ a broker silent past a ping is reconnected');
          client.disconnect();
          server.close();
          console.log('test-mqtt.js passed');
          process.exit(0);
        });
      });
    });
  });
});
