// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var assert = require('assert');
var events = require('events');
var routes = require('../server/lib/routes');

console.log('Running test-routes.js ...');

function createMockReq(opts) {
  opts = opts || {};
  var req = new events.EventEmitter();
  req.url = opts.url || '/';
  req.method = opts.method || 'GET';
  req.headers = opts.headers || {};
  req.connection = { remoteAddress: opts.remoteAddress !== undefined ? opts.remoteAddress : '127.0.0.1' };
  req.destroy = function () { req.destroyed = true; };
  return req;
}

function createMockRes(cb) {
  var res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: function (code, hdrs) {
      res.statusCode = code;
      res.headers = hdrs;
    },
    end: function (chunk) {
      if (chunk) res.body += chunk.toString();
      if (cb) cb(res);
    }
  };
  return res;
}

// 1. Constants and exports integrity
(function testExports() {
  assert.strictEqual(typeof routes.init, 'function');
  assert.strictEqual(typeof routes.handleRequest, 'function');
  assert.strictEqual(typeof routes.send, 'function');
  assert.strictEqual(typeof routes.readJsonBody, 'function');
  assert.strictEqual(typeof routes.authed, 'function');
  assert.strictEqual(typeof routes.fromTV, 'function');
  assert.strictEqual(typeof routes.validateSettings, 'function');
  assert.strictEqual(typeof routes.writeSettings, 'function');
  assert.strictEqual(typeof routes.readConfigFile, 'function');
  assert.strictEqual(typeof routes.setNetworkAccess, 'function');
  assert.strictEqual(typeof routes.lanAddress, 'function');
  assert.strictEqual(typeof routes.networkOpen, 'function');
  assert.strictEqual(typeof routes.lanOrigin, 'function');
  assert.strictEqual(typeof routes.setupPending, 'function');
  assert.strictEqual(typeof routes.setupState, 'function');
  assert.strictEqual(typeof routes.startHandoff, 'function');
  assert.strictEqual(typeof routes.stopHandoff, 'function');
  assert.strictEqual(typeof routes.loadUI, 'function');
  assert.strictEqual(typeof routes.updateSummary, 'function');
  assert.strictEqual(typeof routes.missingAssetsPage, 'function');
  assert.strictEqual(typeof routes.MIME, 'object');

  assert.strictEqual(routes.MIME['.html'], 'text/html; charset=utf-8');
  assert.strictEqual(routes.MIME['.json'], 'application/json; charset=utf-8');

  console.log('  ✓ Module structure and exports are verified');
})();

// 2. Loopback checks (fromTV)
(function testFromTV() {
  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '127.0.0.1' })), true);
  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '::1' })), true);
  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '::ffff:127.0.0.1' })), true);

  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '192.168.1.50' })), false);
  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '10.0.0.2' })), false);
  assert.strictEqual(routes.fromTV(createMockReq({ remoteAddress: '' })), false);
  assert.strictEqual(routes.fromTV(null), false);

  console.log('  ✓ fromTV correctly recognizes local loopback addresses');
})();

// 3. Authentication (authed)
(function testAuthed() {
  var conf = { token: 'secret-token-123', web: { enabled: false } };
  routes.init({ config: conf });

  // Token configured: remote without token is rejected
  var remoteReq = createMockReq({ remoteAddress: '192.168.1.100' });
  assert.strictEqual(routes.authed({}, remoteReq), false);
  assert.strictEqual(routes.authed({ k: 'wrong-token' }, remoteReq), false);

  // Token configured: remote with token is allowed
  assert.strictEqual(routes.authed({ k: 'secret-token-123' }, remoteReq), true);

  // Local loopback is always allowed regardless of token
  var localReq = createMockReq({ remoteAddress: '127.0.0.1' });
  assert.strictEqual(routes.authed({}, localReq), true);

  // No token configured: all are allowed
  routes.init({ config: { token: '', web: { enabled: false } } });
  assert.strictEqual(routes.authed({}, remoteReq), true);

  console.log('  ✓ authed enforces token checks for remote callers and bypasses for local');
})();

// 4. Settings Validation (validateSettings)
(function testValidateSettings() {
  // Empty settings require telemetryIntervalMs and device.id
  var vEmpty = routes.validateSettings({});
  assert.strictEqual(vEmpty.errors.length, 2);

  // Valid base configuration
  var validBase = {
    mqtt: { telemetryIntervalMs: 10000 },
    device: { id: 'lg_living_room' }
  };
  var v1 = routes.validateSettings(validBase);
  assert.strictEqual(v1.errors.length, 0);
  assert.strictEqual(v1.value.mqtt.enabled, false);
  assert.strictEqual(v1.value.mqtt.topicPrefix, 'lgtv');
  assert.strictEqual(v1.value.mqtt.discoveryPrefix, 'homeassistant');
  assert.strictEqual(v1.value.device.id, 'lg_living_room');

  // MQTT enabled without host produces error
  var v2 = routes.validateSettings({
    mqtt: { enabled: true, host: '', telemetryIntervalMs: 10000 },
    device: { id: 'lg_tv' }
  });
  assert.ok(v2.errors.length > 0);
  assert.ok(v2.errors[0].indexOf('broker address is required') !== -1);

  // Port boundaries
  var v3 = routes.validateSettings({
    mqtt: { port: 70000, telemetryIntervalMs: 10000 },
    device: { id: 'lg_tv' }
  });
  assert.ok(v3.errors.length > 0);
  assert.ok(v3.errors[0].indexOf('port must be between 1 and 65535') !== -1);

  var v4 = routes.validateSettings({
    mqtt: { port: 1883, telemetryIntervalMs: 10000 },
    device: { id: 'lg_tv' }
  });
  assert.strictEqual(v4.errors.length, 0);
  assert.strictEqual(v4.value.mqtt.port, 1883);

  // Topic validation
  var v5 = routes.validateSettings({
    mqtt: { topicPrefix: 'invalid/prefix/', telemetryIntervalMs: 10000 },
    device: { id: 'lg_tv' }
  });
  assert.ok(v5.errors.length > 0);

  var v6 = routes.validateSettings({
    mqtt: { topicPrefix: 'valid_prefix', telemetryIntervalMs: 10000 },
    device: { id: 'lg_tv' }
  });
  assert.strictEqual(v6.errors.length, 0);
  assert.strictEqual(v6.value.mqtt.topicPrefix, 'valid_prefix');

  // Device ID validation
  var v7 = routes.validateSettings({
    mqtt: { telemetryIntervalMs: 10000 },
    device: { id: 'bad ID with spaces!' }
  });
  assert.ok(v7.errors.length > 0);

  console.log('  ✓ validateSettings strictly validates broker, ports, topics, and device IDs');
})();

// 5. CSRF & Request Body Parsing (readJsonBody)
(function testReadJsonBody() {
  // Missing or non-json Content-Type
  var reqBadType = createMockReq({
    method: 'POST',
    headers: { 'content-type': 'text/plain' }
  });
  var resBadType = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 415);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'Content-Type must be application/json');
  });
  routes.readJsonBody(reqBadType, resBadType, function () {
    assert.fail('Should not be called on bad Content-Type');
  });

  // Mismatched Origin
  var reqBadOrigin = createMockReq({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'host': '192.168.1.131:8080',
      'origin': 'http://evil-attacker.com'
    }
  });
  var resBadOrigin = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 403);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'cross-origin request refused');
  });
  routes.readJsonBody(reqBadOrigin, resBadOrigin, function () {
    assert.fail('Should not be called on mismatched origin');
  });

  // Malformed JSON
  var reqMalformed = createMockReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  });
  var resMalformed = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'malformed JSON');
  });
  routes.readJsonBody(reqMalformed, resMalformed, function () {
    assert.fail('Should not be called on malformed JSON');
  });
  reqMalformed.emit('data', '{ not valid json');
  reqMalformed.emit('end');

  // Valid JSON and matching Origin
  var reqValid = createMockReq({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'host': '192.168.1.131:8080',
      'origin': 'http://192.168.1.131:8080'
    }
  });
  var resValid = createMockRes();
  var parsedResult = null;
  routes.readJsonBody(reqValid, resValid, function (data) {
    parsedResult = data;
  });
  reqValid.emit('data', JSON.stringify({ action: 'volume', value: 20 }));
  reqValid.emit('end');
  assert.deepEqual(parsedResult, { action: 'volume', value: 20 });

  console.log('  ✓ readJsonBody enforces Content-Type, Origin matching, and JSON parsing');
})();

// 6. Route Dispatching via handleRequest
(function testRouteDispatch() {
  var controlDispatched = null;
  var mockControls = {
    doControl: function (action, val, cb) {
      controlDispatched = { action: action, val: val };
      if (cb) cb({ ok: true });
    }
  };

  routes.init({
    config: {
      web: { enabled: false },
      allowControl: true,
      allowPower: true,
      token: 'test-token',
      port: 8080,
      host: '0.0.0.0'
    },
    version: '0.64.0',
    controls: mockControls,
    fromHomebrewChannel: function () { return false; },
    screensavers: {
      screensaverList: function () {
        return { ok: true, current: 'bokeh', modes: [{ id: 'bokeh', label: 'Bokeh' }] };
      }
    }
  });

  // GET /api/caps
  var reqCaps = createMockReq({ url: '/api/caps?k=test-token', remoteAddress: '192.168.1.50' });
  var resCaps = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.allowControl, true);
    assert.strictEqual(body.version, '0.64.0');
    assert.strictEqual(body.key, undefined, 'Token should not be exposed to remote callers');
  });
  routes.handleRequest(reqCaps, resCaps);

  // Local caller GET /api/caps includes key
  var reqLocalCaps = createMockReq({ url: '/api/caps', remoteAddress: '127.0.0.1' });
  var resLocalCaps = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.key, 'test-token', 'Token should be exposed to TV app on localhost');
  });
  routes.handleRequest(reqLocalCaps, resLocalCaps);

  // Unauthenticated remote GET /api/stats returns 401
  var reqUnauth = createMockReq({ url: '/api/stats', remoteAddress: '192.168.1.50' });
  var resUnauth = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 401);
  });
  routes.handleRequest(reqUnauth, resUnauth);

  // GET /api/screensaver returns catalogue
  var reqSs = createMockReq({ url: '/api/screensaver?k=test-token', remoteAddress: '192.168.1.50' });
  var resSs = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.modes[0].id, 'bokeh');
  });
  routes.handleRequest(reqSs, resSs);

  // POST /api/control dispatches to controls module
  var reqCtrl = createMockReq({
    url: '/api/control?k=test-token',
    method: 'POST',
    remoteAddress: '192.168.1.50',
    headers: {
      'content-type': 'application/json',
      'host': '192.168.1.131:8080'
    }
  });
  var resCtrl = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.deepEqual(controlDispatched, { action: 'volumeUp', val: null });
  });
  routes.handleRequest(reqCtrl, resCtrl);
  reqCtrl.emit('data', JSON.stringify({ action: 'volumeUp' }));
  reqCtrl.emit('end');

  // Unknown route returns 404
  var req404 = createMockReq({ url: '/api/does-not-exist?k=test-token', remoteAddress: '192.168.1.50' });
  var res404 = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 404);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'not found');
  });
  routes.handleRequest(req404, res404);

  console.log('  ✓ handleRequest dispatches endpoints, auth guards, and 404 handling');
})();

console.log('ALL test-routes.js assertions passed!');
