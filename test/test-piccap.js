/* PicCap MQTT state and ON/OFF power control. Strict ES5. */
var assert = require('assert');
var piccapModule = require('../server/lib/piccap');

console.log('Running test-piccap.js ...');
var noopPublishes = [];
var noopClient = {
  connected: true,
  publish: function () { noopPublishes.push(Array.prototype.slice.call(arguments)); }
};
var noopPiccap = piccapModule.initNoop();
noopPiccap.attachMqtt({ client: noopClient, prefix: 'room/tv', allowControl: true });
noopPiccap.refreshAndPublishState();
assert.strictEqual(noopPiccap.handleMqttCommand('piccap/power', 'ON'), false, 'no-op control is not handled');
assert.strictEqual(noopPublishes.length, 0, 'no-op PicCap publishes no MQTT state');
assert.strictEqual(noopPiccap.getState(), null, 'no-op PicCap has no telemetry state');

var replies = [];
var calls = [];
var publishes = [];
var holdNextStatus = false;
var heldStatus = null;
var client = {
  connected: true,
  publish: function (topic, payload, retain) {
    publishes.push({ topic: topic, payload: payload, retain: retain });
  }
};
function luna(uri, payload, cb) {
  calls.push({ uri: uri, payload: payload });
  if (holdNextStatus && uri === 'org.webosbrew.piccap.service/status') {
    holdNextStatus = false;
    heldStatus = cb;
    return;
  }
  var response = replies.shift();
  process.nextTick(function () { cb(response || null, JSON.stringify(response || {})); });
}

var availability = [];
var piccap = piccapModule.init({ luna: luna, onAvailableChange: function (a) { availability.push(a); } });
piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });

function status(isRunning) {
  return { returnValue: true, isRunning: isRunning };
}

function lastState() {
  return publishes[publishes.length - 1];
}

function pollThen(callback, forcePublish) {
  piccap.refreshAndPublishState(forcePublish);
  process.nextTick(callback);
}

function testMissingService() {
  assert.strictEqual(lastState().payload, '', 'missing PicCap clears retained state');
  assert.strictEqual(piccap.getState(), null, 'missing PicCap has no telemetry state');
  replies.push(status(false));
  pollThen(testInitialStatus);
}

function testInitialStatus() {
  assert.strictEqual(lastState().topic, 'room/tv/state/piccap/power');
  assert.strictEqual(lastState().payload, 'OFF');
  assert.strictEqual(lastState().retain, true);
  assert.deepEqual(piccap.getState(), { isRunning: false }, 'a valid status discovers PicCap');
  assert.deepEqual(availability, [true], 'discovery hears once that PicCap answers, not on the missing check before');
  var publishedCount = publishes.length;
  replies.push(status(false));
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unchanged state is not republished');
    publishedCount = publishes.length;
    replies.push(status(false));
    pollThen(function () {
      assert.deepEqual(piccap.getState(), { isRunning: false });
      assert.strictEqual(publishes.length, publishedCount + 1, 'MQTT reconnect republishes state once');
      replies.push(status(true));
      pollThen(testChangedStatus);
    }, true);
  });
}

function testChangedStatus() {
  assert.deepEqual(piccap.getState(), { isRunning: true }, 'poll reads changed capture state');
  assert.strictEqual(lastState().payload, 'ON');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'temporary service error' });
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'transient errors do not republish unchanged state');
    testTransientError();
  });
}

function testTransientError() {
  assert.deepEqual(piccap.getState(), { isRunning: true }, 'a transient error keeps the last known state');
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  pollThen(testRemovedService);
}

function testRemovedService() {
  assert.strictEqual(lastState().payload, '', 'service removal clears retained state');
  assert.strictEqual(piccap.getState(), null, 'an unregistered service is unavailable');
  var publishedCount = publishes.length;
  replies.push({ returnValue: false, errorText: 'Service does not exist' });
  pollThen(function () {
    assert.strictEqual(publishes.length, publishedCount, 'unavailable state is not republished');
    replies.push(status(false));
    pollThen(testReadyForStart);
  });
}

function testReadyForStart() {
  assert.deepEqual(piccap.getState(), { isRunning: false });
  replies.push({ returnValue: true });
  replies.push(status(true));
  assert.strictEqual(piccap.handleMqttCommand('piccap/power', 'ON', testStarted), true);
  assert.strictEqual(piccap.handleMqttCommand('volume', '5'), false, 'other commands stay with tvweb');
  var count = calls.length;
  var logs = [];
  var originalLog = console.log;
  console.log = function (message) { logs.push(String(message)); };
  try {
    assert.strictEqual(piccap.handleMqttCommand('piccap/power', 'invalid'), true);
  } finally {
    console.log = originalLog;
  }
  assert.strictEqual(calls.length, count, 'invalid payloads do not call Luna');
  assert.strictEqual(logs.length, 1, 'invalid payloads are logged');
  assert.ok(logs[0].indexOf('expected ON or OFF') !== -1, 'invalid payloads explain the expected command');
}

function testStarted(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isRunning, true, 'power command refreshes status');
  assert.strictEqual(lastState().payload, 'ON', 'power command publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'org.webosbrew.piccap.service/start';
  }), 'ON calls PicCap start');
  replies.push({ returnValue: true });
  replies.push(status(false));
  piccap.handleMqttCommand('piccap/power', 'OFF', testStopped);
}

function testStopped(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isRunning, false);
  assert.strictEqual(lastState().payload, 'OFF', 'stop publishes refreshed state');
  assert.ok(calls.some(function (call) {
    return call.uri === 'org.webosbrew.piccap.service/stop';
  }), 'OFF calls PicCap stop');
  piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: false });
  var commandCount = calls.length;
  piccap.handleMqttCommand('piccap/power', 'ON', testControlsDisabled);
  assert.strictEqual(calls.length, commandCount, 'allowControl blocks MQTT power commands');
}

function testControlsDisabled(result) {
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'controls disabled in config');
  piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });
  holdNextStatus = true;
  var callsBeforeRefresh = calls.length;
  piccap.refreshAndPublishState();
  piccap.refreshAndPublishState();
  assert.strictEqual(calls.length, callsBeforeRefresh + 1, 'overlapping refreshes share the in-flight request');
  assert.deepEqual(piccap.getState(), { isRunning: false }, 'getter returns cached state during a refresh');
  assert.strictEqual(calls.length, callsBeforeRefresh + 1, 'getter does not poll Luna');
  assert.ok(heldStatus, 'first status request is held');
  replies.push(status(true));
  heldStatus(status(false), JSON.stringify(status(false)));
  assert.deepEqual(piccap.getState(), { isRunning: false }, 'first refresh applies its result');
  assert.strictEqual(calls.length, callsBeforeRefresh + 2, 'overlapping forced refresh requests a fresh status');
  process.nextTick(function () {
    assert.deepEqual(piccap.getState(), { isRunning: true }, 'forced refresh applies the fresh result');
    assert.strictEqual(lastState().payload, 'ON');
    testPollingTimer();
  });
}

function testPollingTimer() {
  var callsBeforeTimer = calls.length;
  replies.push(status(true));
  piccapModule.init({ luna: luna, pollIntervalMs: 1000 });
  piccap.attachMqtt({ client: client, prefix: 'room/tv', allowControl: true });
  setTimeout(function () {
    assert.strictEqual(calls.length, callsBeforeTimer + 1, 'periodic refresh checks PicCap status');
    assert.strictEqual(calls[callsBeforeTimer].uri, 'org.webosbrew.piccap.service/status');
    assert.deepEqual(availability, [true, false, true], 'and again each time it goes and comes back, not while it keeps answering');
    assert.strictEqual(piccapModule.installed(), require('fs').existsSync(piccapModule.APP_DIR), 'installed is the app folder');
    console.log('  ✓ PicCap detection, MQTT commands, telemetry, and retained state');
    console.log('ALL test-piccap.js assertions passed!\n');
    process.exit(0);
  }, 1200);
}

replies.push({ returnValue: false, errorText: 'Unknown method "org.webosbrew.piccap.service/status"' });
pollThen(testMissingService);
