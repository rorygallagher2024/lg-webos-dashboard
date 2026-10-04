// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var path = require('path');
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
  assert.strictEqual(typeof routes.parseUrl, 'function');
  assert.strictEqual(typeof routes.MIME, 'object');

  assert.strictEqual(routes.MIME['.html'], 'text/html; charset=utf-8');
  assert.strictEqual(routes.MIME['.json'], 'application/json; charset=utf-8');

  console.log('  ✓ Module structure and exports are verified');
})();

// 1b. URL Parsing (parseUrl)
(function testParseUrl() {
  var u1 = routes.parseUrl('/api/stats?k=token123&section=display');
  assert.strictEqual(u1.pathname, '/api/stats');
  assert.strictEqual(u1.query.k, 'token123');
  assert.strictEqual(u1.query.section, 'display');

  var u2 = routes.parseUrl('');
  assert.strictEqual(u2.pathname, '/');
  assert.deepEqual(u2.query, {});

  var u3 = routes.parseUrl(null);
  assert.strictEqual(u3.pathname, '/');
  assert.deepEqual(u3.query, {});

  console.log('  ✓ parseUrl handles query strings and missing paths cleanly');
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

  // Non-object JSON
  var reqNonObject = createMockReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  });
  var resNonObject = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'malformed JSON');
  });
  routes.readJsonBody(reqNonObject, resNonObject, function () {
    assert.fail('Should not be called on non-object JSON');
  });
  reqNonObject.emit('data', '12345');
  reqNonObject.emit('end');

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
    assetPath: function (sub) {
      var p = path.join(__dirname, '..', 'server', 'assets', sub);
      return fs.existsSync(p) ? p : null;
    },
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

  // POST /api/control with invalid JSON body returns 400
  var reqBadCtrl = createMockReq({
    url: '/api/control?k=test-token',
    method: 'POST',
    remoteAddress: '192.168.1.50',
    headers: {
      'content-type': 'application/json',
      'host': '192.168.1.131:8080'
    }
  });
  var resBadCtrl = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error, 'malformed JSON');
  });
  routes.handleRequest(reqBadCtrl, resBadCtrl);
  reqBadCtrl.emit('data', '{ not valid');
  reqBadCtrl.emit('end');

  // Static assets: GET /assets/i18n.js returns 200 with ETag
  var assetEtag = null;
  var reqAsset = createMockReq({ url: '/assets/i18n.js', remoteAddress: '192.168.1.50' });
  var resAsset = createMockRes(function (res) {
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers && res.headers['ETag'], 'Static asset should return ETag');
    assetEtag = res.headers['ETag'];
    assert.ok(res.body.length > 0);

    // Static assets: GET with matching If-None-Match returns 304 Not Modified
    var reqAsset304 = createMockReq({
      url: '/assets/i18n.js',
      remoteAddress: '192.168.1.50',
      headers: { 'if-none-match': assetEtag }
    });
    var resAsset304 = createMockRes(function (r304) {
      assert.strictEqual(r304.statusCode, 304);
      assert.strictEqual(r304.body, '', '304 response should have empty body');
    });
    routes.handleRequest(reqAsset304, resAsset304);
  });
  routes.handleRequest(reqAsset, resAsset);

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

// A dashboard uninstall that succeeds tells the server the apps changed; one
// that fails does not.
(function () {
  var changed = 0;
  routes.init({
    config: { web: { enabled: false }, allowControl: true, token: 'test-token', port: 8080, host: '0.0.0.0' },
    apps: { uninstallApp: function (id, cb) { cb({ ok: id === 'spotify-beehive' }); } },
    appsChanged: function () { changed++; }
  });
  function uninstall(id, expectCode, then) {
    var req = createMockReq({
      url: '/api/apps/uninstall?k=test-token', method: 'POST', remoteAddress: '192.168.1.50',
      headers: { 'content-type': 'application/json', 'host': '192.168.1.131:8080' }
    });
    var res = createMockRes(function (r) {
      assert.strictEqual(r.statusCode, expectCode);
      then();
    });
    routes.handleRequest(req, res);
    req.emit('data', JSON.stringify({ id: id }));
    req.emit('end');
  }
  uninstall('spotify-beehive', 200, function () {
    assert.strictEqual(changed, 1);
    uninstall('com.webos.app.livetv', 400, function () {
      assert.strictEqual(changed, 1);
      console.log('  ✓ a dashboard uninstall refreshes the app list only when it succeeds');
    });
  });
})();

// 6. Install routes: Host check, controls switch, catalog, install flow, restart refusal
(function testInstallRoutes() {
  var calls = [];
  var busy = false;      // a job is downloading or installing
  var waiting = false;   // a preview is waiting for confirmation
  var pkg = { id: 'org.example.app', title: 'Example', version: '1.0.0', ipkUrl: 'https://example.org/a.ipk', sha256: new Array(65).join('a') };
  var repoStub = {
    getCatalog: function (force, cb) { calls.push(['catalog', force]); cb({ ok: true, apps: [pkg], fetchedAt: 1 }); },
    findPackage: function (id, cb) { calls.push(['find', id]); id === pkg.id ? cb(null, pkg) : cb(new Error('not in the catalog: ' + id)); }
  };
  var snap = { state: 'downloading', jobId: 'j1', progress: { bytes: 0, total: null }, preview: null, error: null, result: null };
  var installerStub = {
    start: function (r, cb) { calls.push(['start', r]); cb(null, snap); },
    confirm: function (r, cb) { calls.push(['confirm', r]); cb(null, snap); },
    cancel: function (id, cb) { calls.push(['cancel', id]); cb(null); },
    status: function () { return { state: busy ? 'installing' : 'idle', jobId: null, progress: null, preview: null, error: null, result: null }; },
    isBusy: function () { return busy || waiting; },
    isWorking: function () { return busy; }
  };
  var restarts = 0;
  var written = 0;
  var cfgFile = path.join(require('os').tmpdir(), 'tvweb-routes-test-' + process.pid + '.json');
  function setup(conf) {
    calls = [];
    routes.init({
      config: conf, configFile: cfgFile, repo: repoStub, installer: installerStub,
      restartSelf: function () { restarts++; return true; }
    });
  }
  var checks = 0;
  function call(method, url, host, body, cb, remote) {
    var req = createMockReq({
      url: url, method: method, remoteAddress: remote || '192.168.1.50',
      headers: { 'content-type': 'application/json', host: host }
    });
    var res = createMockRes(function (r) { checks++; cb(r, r.body ? JSON.parse(r.body) : null); });
    routes.handleRequest(req, res);
    if (method === 'POST') {
      req.emit('data', JSON.stringify(body || {}));
      req.emit('end');
    }
  }
  var base = { allowControl: true, token: '', web: { enabled: false } };
  var HOST = '192.168.1.131:8080';

  // Host check: refused names, accepted literals, localhost and listed names
  setup({ allowControl: true, token: '', web: { enabled: false }, apps: { hosts: ['lgtv.local'] } });
  var paths = ['/api/apps/catalog', '/api/apps/install/status'];
  ['evil.example', 'evil.example:8080', 'lgtv.local.evil.example', '', 'lgtv.localx'].forEach(function (h) {
    paths.forEach(function (u) {
      call('GET', u, h, null, function (r, b) {
        assert.strictEqual(r.statusCode, 403, 'host "' + h + '" must be refused');
        assert.ok(/apps\.hosts/.test(b.error), 'the refusal names apps.hosts');
      });
    });
  });
  call('POST', '/api/apps/install/fetch', 'evil.example', { id: pkg.id }, function (r) {
    assert.strictEqual(r.statusCode, 403);
  });
  assert.strictEqual(calls.length, 0, 'a refused host reaches neither repo nor installer');
  ['192.168.1.131', HOST, '[::1]:8080', '[fe80::1]', 'localhost:8080', 'LOCALHOST', 'lgtv.local', 'LGTV.local:8080', 'lgtv.local.'].forEach(function (h) {
    call('GET', '/api/apps/install/status', h, null, function (r, b) {
      assert.strictEqual(r.statusCode, 200, 'host "' + h + '" must be accepted');
      assert.strictEqual(b.state, 'idle');
    });
  });

  // The Host check comes before the token check
  setup({ allowControl: true, token: 'tok', web: { enabled: false }, apps: {} });
  call('GET', '/api/apps/catalog', 'evil.example', null, function (r) { assert.strictEqual(r.statusCode, 403); });
  call('GET', '/api/apps/catalog', HOST, null, function (r) { assert.strictEqual(r.statusCode, 401); });
  call('GET', '/api/apps/catalog?k=tok', HOST, null, function (r) { assert.strictEqual(r.statusCode, 200); });

  // Controls off
  setup({ allowControl: false, token: '', web: { enabled: false } });
  call('GET', '/api/apps/catalog', HOST, null, function (r) { assert.strictEqual(r.statusCode, 403); });
  call('POST', '/api/apps/install/fetch', HOST, { id: pkg.id }, function (r) { assert.strictEqual(r.statusCode, 403); });
  call('POST', '/api/apps/install/confirm', HOST, { jobId: 'j1' }, function (r) { assert.strictEqual(r.statusCode, 403); });
  assert.strictEqual(calls.length, 0);

  // Catalog and install flow
  setup(base);
  call('GET', '/api/apps/catalog?force=1', HOST, null, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.apps[0].id, pkg.id);
    assert.deepEqual(calls.pop(), ['catalog', true]);
  });
  call('GET', '/api/apps/catalog', HOST, null, function () { assert.deepEqual(calls.pop(), ['catalog', false]); });
  call('GET', '/api/apps/install/status', HOST, null, function (r, b) {
    assert.strictEqual(b.writable, true);
    assert.strictEqual(b.state, 'idle');
  });
  call('POST', '/api/apps/install/fetch', HOST, { id: pkg.id }, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.install.jobId, 'j1');
    var start = calls.pop();
    assert.strictEqual(start[0], 'start');
    assert.strictEqual(start[1].source, 'catalog');
    assert.strictEqual(start[1].pkg.id, pkg.id);
  });
  call('POST', '/api/apps/install/fetch', HOST, { id: 'nope' }, function (r, b) {
    assert.strictEqual(r.statusCode, 400);
    assert.ok(/not in the catalog/.test(b.error));
  });
  call('POST', '/api/apps/install/fetch', HOST, {}, function (r, b) {
    assert.strictEqual(r.statusCode, 400);
    assert.ok(/app id is required/.test(b.error));
  });
  calls = [];
  call('POST', '/api/apps/install/confirm', HOST, { jobId: 'j1', elevate: true, confirmRoot: ['a.service'], replaceStore: 'yes' }, function (r) {
    assert.strictEqual(r.statusCode, 200);
    assert.deepEqual(calls.pop(), ['confirm', { jobId: 'j1', elevate: true, confirmRoot: ['a.service'], replaceStore: false }]);
  });
  call('POST', '/api/apps/install/cancel', HOST, { jobId: 'j1' }, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.ok, true);
    assert.deepEqual(calls.pop(), ['cancel', 'j1']);
  });
  call('POST', '/api/apps/install/fetch', HOST, { id: pkg.id, auto: true }, function (r) {
    assert.strictEqual(r.statusCode, 200);
    var start = calls.pop();
    assert.strictEqual(start[1].auto, true);
  });
  call('POST', '/api/apps/install/sideload', HOST, { enabled: true }, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.sideload, true);
  });
  call('POST', '/api/apps/install/sideload', HOST, { enabled: false }, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.sideload, false);
  });
  // An installer refusal is reported as an error, not a success
  var realStart = installerStub.start;
  installerStub.start = function (r, cb) { cb('an install is already in progress'); };
  call('POST', '/api/apps/install/fetch', HOST, { id: pkg.id }, function (r, b) {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(b.error, 'an install is already in progress');
  });
  installerStub.start = realStart;
  // Wrong method and content type
  call('GET', '/api/apps/install/fetch', HOST, null, function (r) { assert.strictEqual(r.statusCode, 404); });
  var badType = createMockReq({ url: '/api/apps/install/fetch', method: 'POST', headers: { host: HOST, 'content-type': 'text/plain' } });
  routes.handleRequest(badType, createMockRes(function (r) { checks++; assert.strictEqual(r.statusCode, 415); }));

  // apps.* is file-only: the settings form cannot write it
  var v = routes.validateSettings({ mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' }, apps: { hosts: ['evil.example'], repos: ['http://x'] } });
  assert.strictEqual(v.value.apps, undefined);
  assert.deepEqual(Object.keys(v.value).sort(), ['device', 'mqtt']);

  // Restart paths refuse while an install runs, before anything is written
  setup(base);
  try { fs.unlinkSync(cfgFile); } catch (e) {}
  busy = true;
  call('POST', '/api/settings', HOST, { mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' } }, function (r, b) {
    assert.strictEqual(r.statusCode, 409);
    assert.ok(/install is in progress/.test(b.error));
  });
  call('POST', '/api/setup', HOST, { action: 'network', open: true }, function (r, b) {
    assert.strictEqual(r.statusCode, 409);
  }, '127.0.0.1');
  assert.ok(!fs.existsSync(cfgFile), 'a refused settings save writes nothing');
  assert.strictEqual(restarts, 0);
  busy = false;

  // A preview waiting for confirmation does not hold the network switch
  // (already open here, so nothing is written or restarted)
  waiting = true;
  call('POST', '/api/setup', HOST, { action: 'network', open: true }, function (r, b) {
    assert.strictEqual(r.statusCode, 200, JSON.stringify(b));
    assert.strictEqual(b.restarting, false);
  }, '127.0.0.1');
  waiting = false;

  assert.strictEqual(checks, 43, 'every callback ran');
  try { fs.unlinkSync(cfgFile); } catch (e) {}
  console.log('  ✓ install routes: Host check, controls switch, catalog, install flow, restart refusal');
})();

// 7. Sideload routes: opt-in gating, URL checks, upload streaming
(function testSideloadRoutes() {
  var os = require('os');
  var childProcess = require('child_process');
  var installer = require('../server/lib/installer');
  var fetchLib = require('../server/lib/fetch');
  var root = path.join(os.tmpdir(), 'tvweb-sideload-test-' + process.pid);
  var staging = path.join(root, 'staging');
  childProcess.execSync('mkdir -p "' + staging + '" "' + path.join(root, 'state') + '"');
  var cfgFile = path.join(root, 'config.json');
  var df = path.join(root, 'df');
  function fakeDf(avail) {
    fs.writeFileSync(df, '#!/bin/sh\nprintf "Filesystem 1K-blocks Used Available Use%% Mounted on\\n/dev/x 9999 1 ' + avail + ' 1%% /\\n"\n');
    fs.chmodSync(df, parseInt('755', 8));
  }
  var started = [];
  var touched = 0;
  var realStart = installer.start;
  // Records what the route handed over, and the staged file as it was at that moment.
  var wrapper = {
    start: function (r, cb) {
      var rec = { req: r };
      if (r.source === 'file') {
        rec.exists = fs.existsSync(r.path);
        rec.body = rec.exists ? fs.readFileSync(r.path) : null;
      }
      started.push(rec);
      if (r.source === 'url') return cb(null, { state: 'downloading', jobId: 'j1' });
      realStart(r, cb);
    },
    confirm: installer.confirm, cancel: installer.cancel, status: installer.status, isBusy: installer.isBusy,
    isWorking: installer.isWorking, prepareUpload: installer.prepareUpload, releaseUpload: installer.releaseUpload,
    touchUpload: function () { touched++; installer.touchUpload(); }
  };
  function initInstaller(caps) {
    installer.init({
      luna: function (m, p, cb) { cb({ returnValue: true, apps: [] }); },
      stateDir: path.join(root, 'state'), stagingDir: staging, dfPath: df,
      caps: caps || { uploadBytes: 1000 }, fetch: fetchLib, tvMachine: 'arm'
    });
  }
  function init(conf, avail, caps) {
    started = [];
    touched = 0;
    fakeDf(avail === undefined ? 9999999 : avail);
    initInstaller(caps);
    routes.init({
      config: conf, configFile: cfgFile, installer: wrapper, repo: {},
      restartSelf: function () { return true; }
    });
  }
  function staged() { return fs.readdirSync(staging); }
  var HOST = '192.168.1.131:8080';
  var REMOTE = '192.168.1.50';
  var base = { allowControl: true, token: '', web: { enabled: false } };
  var open = { allowControl: true, token: '', web: { enabled: false }, apps: { sideload: true } };

  function postJson(url, body, remote, cb, host) {
    var req = createMockReq({
      url: url, method: 'POST', remoteAddress: remote || REMOTE,
      headers: { 'content-type': 'application/json', host: host || HOST }
    });
    routes.handleRequest(req, createMockRes(function (r) { cb(r, r.body ? JSON.parse(r.body) : null); }));
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  }
  function getJson(url, remote, cb) {
    var req = createMockReq({ url: url, remoteAddress: remote || REMOTE, headers: { host: HOST } });
    routes.handleRequest(req, createMockRes(function (r) { cb(r, JSON.parse(r.body)); }));
  }

  /*
   * An upload request. The chunks arrive on later ticks, so the route has its
   * file open by then; `then` is 'end' (default), 'abort', 'close' or 'none'.
   * cb(res, body, req) runs when the route answers, or at once for an abort.
   */
  function upload(o, cb) {
    var h = { host: HOST };
    if (o.type !== null) h['content-type'] = o.type || 'application/octet-stream';
    if (o.length !== undefined) h['content-length'] = String(o.length);
    for (var k in o.headers || {}) h[k] = o.headers[k];
    var req = createMockReq({ url: '/api/apps/install/upload', method: 'POST', remoteAddress: REMOTE, headers: h });
    req.paused = 0;
    req.resumed = 0;
    req.pause = function () { req.paused++; };
    req.resume = function () { req.resumed++; };
    routes.handleRequest(req, createMockRes(function (r) { cb(r, r.body ? JSON.parse(r.body) : null, req); }));
    var chunks = o.chunks || [];
    (function next(i) {
      setTimeout(function () {
        if (req.destroyed) return;
        if (i < chunks.length) { req.emit('data', chunks[i]); return next(i + 1); }
        if (o.then === 'abort') { req.emit('aborted'); req.emit('close'); return cb(null, null, req); }
        if (o.then === 'close') { req.emit('close'); return cb(null, null, req); }
        if (o.then !== 'none') req.emit('end');
      }, 15);
    })(0);
  }
  function later(fn) { setTimeout(fn, 120); }
  var FILE = new Buffer('0123456789');
  var ok = { url: 'https://example.org/app.ipk' };

  // Gating matrix on the URL route
  init(base);
  postJson('/api/apps/install/url', ok, REMOTE, function (r, b) {
    assert.strictEqual(r.statusCode, 403, 'no token, no opt-in, not the TV: refused');
    assert.ok(/sideload/.test(b.error) && /token/.test(b.error), 'the refusal says how to turn it on');
  });
  assert.strictEqual(started.length, 0);
  postJson('/api/apps/install/url', ok, '127.0.0.1', function (r) { assert.strictEqual(r.statusCode, 200, 'the TV itself is allowed'); }, '127.0.0.1:8080');
  postJson('/api/apps/install/url', ok, '::ffff:127.0.0.1', function (r) { assert.strictEqual(r.statusCode, 200); });
  postJson('/api/apps/install/url', ok, '::1', function (r) { assert.strictEqual(r.statusCode, 200); }, '[::1]:8080');
  assert.deepEqual(started.map(function (s) { return s.req.source; }), ['url', 'url', 'url']);
  getJson('/api/apps/install/status', REMOTE, function (r, b) {
    assert.strictEqual(b.sideload, false);
    assert.strictEqual(b.sideloadVia, null);
  });
  getJson('/api/apps/install/status', '127.0.0.1', function (r, b) {
    assert.strictEqual(b.sideload, true);
    assert.strictEqual(b.sideloadVia, 'tv');
  });

  init(open);
  postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 200, 'apps.sideload opens it'); });
  getJson('/api/apps/install/status', REMOTE, function (r, b) { assert.strictEqual(b.sideloadVia, 'config'); });
  ['true', 1, 'yes'].forEach(function (v) {
    init({ allowControl: true, token: '', web: { enabled: false }, apps: { sideload: v } });
    postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 403, 'only boolean true counts'); });
  });

  init({ allowControl: true, token: 'tok', web: { enabled: false }, apps: {} });
  postJson('/api/apps/install/url?k=tok', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 200, 'a token opens it'); });
  postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 401, 'and is still required'); });
  getJson('/api/apps/install/status?k=tok', REMOTE, function (r, b) { assert.strictEqual(b.sideloadVia, 'token'); });

  // The Host check comes first, then the controls switch
  init(open);
  postJson('/api/apps/install/url', ok, REMOTE, function (r, b) {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/apps\.hosts/.test(b.error), 'refused by the Host check, not the sideload rule');
  }, 'evil.example');
  upload({ length: 10, chunks: [FILE], headers: { host: 'evil.example' } }, function (r, b) {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/apps\.hosts/.test(b.error));
  });
  // The Apps tab's switch opens and closes it, and is saved to config.json
  try { fs.unlinkSync(cfgFile); } catch (e) {}
  init({ allowControl: true, token: '', web: { enabled: false } });
  postJson('/api/apps/install/sideload', { enabled: true }, REMOTE, function (r, b) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(b.sideloadVia, 'config');
  });
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).apps.sideload, true);
  postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 200, 'the switch opens it'); });
  postJson('/api/apps/install/sideload', { enabled: 'yes' }, REMOTE, function (r, b) { assert.strictEqual(b.sideload, false, 'only boolean true turns it on'); });
  postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 403, 'and switching off closes it'); });
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).apps.sideload, false);
  postJson('/api/apps/install/sideload', { enabled: true }, REMOTE, function (r, b) {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/apps\.hosts/.test(b.error), 'a rebinding page cannot flip it');
  }, 'evil.example');
  init({ allowControl: true, token: 'tok', web: { enabled: false } });
  postJson('/api/apps/install/sideload', { enabled: true }, REMOTE, function (r) { assert.strictEqual(r.statusCode, 401, 'a token guards it'); });
  init({ allowControl: false, token: '', web: { enabled: false } });
  postJson('/api/apps/install/sideload', { enabled: true }, REMOTE, function (r) { assert.strictEqual(r.statusCode, 403, 'so does allowControl'); });
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).apps.sideload, false, 'refused requests change nothing');
  fs.unlinkSync(cfgFile);

  init({ allowControl: false, token: '', web: { enabled: false }, apps: { sideload: true } });
  postJson('/api/apps/install/url', ok, REMOTE, function (r) { assert.strictEqual(r.statusCode, 403); });
  upload({ length: 10, chunks: [FILE] }, function (r) { assert.strictEqual(r.statusCode, 403); });
  assert.strictEqual(started.length, 0);

  // Gating on the upload route
  init(base);
  upload({ length: 10, chunks: [FILE] }, function (r, b) {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/sideload/.test(b.error));
    assert.deepEqual(staged(), [], 'nothing is written for a refused upload');
    assert.strictEqual(started.length, 0);
  });

  // URL validation: nothing malformed reaches the installer
  init(open);
  ['-K/etc/passwd', '--output=/etc/x', 'file:///etc/passwd', 'ftp://example.org/a.ipk', 'https://example.org/a b.ipk',
    'https://example.org/a\nX: y', 'https://example.org/a\u0000', '', 'x', 7, null, 'https://' + new Array(2100).join('a') + '.org/'].forEach(function (u) {
    postJson('/api/apps/install/url', { url: u }, REMOTE, function (r, b) {
      assert.strictEqual(r.statusCode, 400, 'url ' + JSON.stringify(u).slice(0, 40) + ' must be refused');
      assert.strictEqual(b.ok, false);
    });
  });
  ['xyz', new Array(64).join('a'), new Array(66).join('a'), 5].forEach(function (h) {
    postJson('/api/apps/install/url', { url: ok.url, sha256: h }, REMOTE, function (r, b) {
      assert.strictEqual(r.statusCode, 400, 'hash ' + h + ' must be refused');
      assert.ok(/sha256/.test(b.error));
    });
  });
  assert.strictEqual(started.length, 0, 'a refused URL never reaches the installer');
  var good = new Array(65).join('A');
  postJson('/api/apps/install/url', { url: ok.url, sha256: good }, REMOTE, function (r) {
    assert.strictEqual(r.statusCode, 200);
    assert.deepEqual(started.pop().req, { source: 'url', url: ok.url, sha256: good });
  });
  postJson('/api/apps/install/url', { url: ok.url, sha256: '' }, REMOTE, function (r) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(started.pop().req.sha256, null);
  });

  // apps.sideload cannot be set from the settings form, in the validator or on the wire
  var v = routes.validateSettings({ mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' }, apps: { sideload: true } });
  assert.strictEqual(v.value.apps, undefined);
  init(base);
  postJson('/api/settings', { mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' }, apps: { sideload: true } }, '127.0.0.1', function (r) {
    assert.strictEqual(r.statusCode, 200);
    var written = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.strictEqual(written.apps, undefined, 'the saved file has no apps section');
  }, '127.0.0.1:8080');

  // The PicCap switch: only piccap.enabled is written, and only when sent
  fs.writeFileSync(cfgFile, JSON.stringify({ piccap: { enabled: false, pollIntervalMs: 5000 } }));
  init({ allowControl: true, token: '', web: { enabled: false }, piccap: { enabled: false } });
  routes.init({ getMqttStatus: function () { return { state: 'off' }; } });
  getJson('/api/settings', '127.0.0.1', function (r, b) {
    assert.deepEqual(b.piccap, { installed: false, enabled: false }, 'offered only where PicCap is installed or still on');
  });
  postJson('/api/settings', { mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' }, piccap: { enabled: true, pollIntervalMs: 1 } }, '127.0.0.1', function (r) {
    assert.strictEqual(r.statusCode, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).piccap, { enabled: true, pollIntervalMs: 5000 });
  }, '127.0.0.1:8080');
  postJson('/api/settings', { mqtt: { telemetryIntervalMs: 10000 }, device: { id: 'lg' } }, '127.0.0.1', function (r) {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).piccap.enabled, true, 'a form without the switch leaves it alone');
  }, '127.0.0.1:8080');
  fs.unlinkSync(cfgFile);

  // Upload: request rules, all refused before a byte is written
  init(open);
  ['multipart/form-data; boundary=x', 'application/json', 'text/plain', 'application/octet-stream; charset=binary',
    'application/x-www-form-urlencoded', null].forEach(function (ty) {
    upload({ type: ty, length: 10, chunks: [FILE], then: 'none' }, function (r) {
      assert.strictEqual(r.statusCode, 415, 'content type ' + ty + ' must be refused');
      assert.deepEqual(staged(), []);
    });
  });
  upload({ chunks: [FILE], then: 'none' }, function (r, b) {
    assert.strictEqual(r.statusCode, 411, 'no Content-Length');
    assert.ok(/in advance/.test(b.error));
  });
  upload({ length: 10, headers: { 'transfer-encoding': 'chunked' }, chunks: [FILE], then: 'none' }, function (r) {
    assert.strictEqual(r.statusCode, 411, 'chunked is refused even with a length');
  });
  ['abc', '0', '-5', '1e3', '99999999999999999999'].forEach(function (n) {
    upload({ length: n, then: 'none' }, function (r) { assert.strictEqual(r.statusCode, 400, 'length ' + n); });
  });
  upload({ length: 10, headers: { origin: 'https://evil.example' }, chunks: [FILE], then: 'none' }, function (r) {
    assert.strictEqual(r.statusCode, 403, 'a cross-origin upload is refused');
  });
  upload({ length: 1001, then: 'none' }, function (r, b) {
    assert.strictEqual(r.statusCode, 413);
    assert.ok(/larger than/.test(b.error));
    assert.deepEqual(staged(), []);
  });
  assert.strictEqual(started.length, 0, 'none of these reached the installer');

  later(function () {
    // Not enough space: the file needs three times its size
    init(open, 1);
    upload({ length: 500, chunks: [new Buffer(500)], then: 'none' }, function (r, b) {
      assert.strictEqual(r.statusCode, 507);
      assert.ok(/not enough free space/.test(b.error));
      assert.deepEqual(staged(), []);
      happy();
    });
  });

  function happy() {
    // The bytes land in the staging directory and the installer is given that path
    init(open);
    upload({ type: 'Application/Octet-Stream', length: 10, chunks: [FILE.slice(0, 4), FILE.slice(4)] }, function (r, b) {
      assert.strictEqual(r.statusCode, 200, 'the type is case-insensitive');
      assert.strictEqual(b.ok, true);
      assert.strictEqual(touched, 2, 'each chunk refreshes the upload hold');
      assert.strictEqual(started.length, 1);
      var s = started[0];
      assert.strictEqual(s.req.source, 'file');
      assert.strictEqual(path.dirname(s.req.path), staging);
      assert.ok(s.exists);
      assert.strictEqual(s.body.toString(), '0123456789');
      later(backpressure);
    });
  }

  function backpressure() {
    // The job that followed rejected the junk bytes and cleared its staging directory
    assert.deepEqual(staged(), []);
    init(open, undefined, { uploadBytes: 10 * 1024 * 1024 });
    var big = new Buffer(512 * 1024);
    big.fill(7);
    upload({ length: big.length, chunks: [big] }, function (r, b, req) {
      assert.strictEqual(r.statusCode, 200);
      assert.ok(req.paused >= 1, 'the request was paused while the file caught up');
      assert.ok(req.resumed >= 1, 'and resumed');
      assert.strictEqual(started[0].body.length, big.length);
      later(mismatch);
    });
  }

  function mismatch() {
    init(open);
    upload({ length: 10, chunks: [new Buffer(6), new Buffer(6)], then: 'none' }, function (r, b) {
      assert.strictEqual(r.statusCode, 400);
      assert.ok(/stated size/.test(b.error));
      later(function () {
        assert.deepEqual(staged(), [], 'an oversize upload leaves no file');
        upload({ length: 10, chunks: [new Buffer(6)] }, function (r2) {
          assert.strictEqual(r2.statusCode, 400, 'a body that ends early is refused');
          later(function () {
            assert.deepEqual(staged(), [], 'a short upload leaves no file');
            aborted();
          });
        });
      });
    });
  }

  function aborted() {
    // Aborted and closed uploads leave nothing behind and free the way for the next
    upload({ length: 10, chunks: [new Buffer(6)], then: 'abort' }, function () {
      later(function () {
        assert.deepEqual(staged(), [], 'an aborted upload leaves no file');
        upload({ length: 10, chunks: [new Buffer(3)], then: 'close' }, function () {
          later(function () {
            assert.deepEqual(staged(), [], 'a closed connection leaves no file');
            upload({ length: 10, chunks: [], then: 'abort' }, function () {
              later(function () {
                assert.deepEqual(staged(), [], 'an upload aborted before its file opened leaves no file');
                assert.strictEqual(started.length, 0);
                oneAtATime();
              });
            });
          });
        });
      });
    });
  }

  function oneAtATime() {
    upload({ length: 10, chunks: [new Buffer(3)], then: 'none' }, function () {});
    setTimeout(function () {
      upload({ length: 10, chunks: [FILE] }, function (r) {
        assert.strictEqual(r.statusCode, 409, 'a second upload is refused while one is streaming');
        initInstaller();
        try { childProcess.execSync('rm -rf "' + root + '"'); } catch (e) {}
        console.log('  ✓ sideload routes: opt-in gating, Host check first, URL checks, upload streaming and cleanup');
      });
    }, 60);
  }
})();

console.log('ALL test-routes.js assertions passed!');
