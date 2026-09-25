// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var path = require('path');
var os = require('os');
var url = require('url');
var zlib = require('zlib');
var crypto = require('crypto');
var http = require('http');
var say = require('./say');
var msg = say.msg;
var ha = require('./ha');

var HA_CATEGORIES = ha.HA_CATEGORIES;
var HA_ENTITIES = ha.HA_ENTITIES;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

var config = {};
var configFilePath = '';
var controlsModule = null;
var telemetryModule = null;
var oledModule = null;
var privacyModule = null;
var lgSettingsModule = null;
var gameModule = null;
var appsModule = null;
var servicesModule = null;
var screensaversModule = null;
var updaterModule = null;
var tvAppFn = null;
var restartSelfFn = null;
var fromHbcFn = null;
var tileHidingOffMsg = '';
var assetPathFn = null;
var assetDirsList = [];
var lunaFn = null;
var getMqttStatusFn = null;
var versionStr = '';

// ---------------------------------------------------------------- first-run setup
/*
 * Setup screens on the TV: opening the dashboard to the network and connecting
 * Home Assistant. An installer that leaves SETUP_PENDING shows them at first
 * launch; the Settings tab offers the same afterwards. Everything here is
 * reachable only from the TV (fromTV), and through its own endpoint rather
 * than the control actions, which MQTT and the
 * network can reach: whoever holds the remote is the owner, a phone on the
 * network is not.
 */
var SETUP_PENDING = '/var/lib/tvweb/.setup-pending';
/*
 * Home Assistant is set up on a phone, not typed with a remote. With the
 * dashboard closed the phone cannot reach it, so a second, short-lived
 * listener opens beside it serving only that one form, behind a one-time code
 * carried in the QR code. It closes when the form is sent, after ten minutes,
 * or when the TV leaves the screen - whichever is first.
 */
var HANDOFF = { server: null, code: null, timer: null };
var HANDOFF_MS = 10 * 60 * 1000;

var UI_HTML = null;
var UI_HTML_GZ = null;
var ASSET_CACHE = {};

// What tvweb.js passes to init(). Called as given: a module left unwired fails
// at the call, where it shows, rather than answering with empty data.
function assetPath(rel) { return assetPathFn(rel); }
function fromHomebrewChannel() { return fromHbcFn(); }
function tvApp(action, cb) { return tvAppFn(action, cb); }
function restartSelf() { return restartSelfFn(); }
function doControl(action, value, cb) { return controlsModule.doControl(action, value, cb); }
function luna(uri, payload, cb) { return lunaFn(uri, payload, cb); }
function getMqttStatus() { return getMqttStatusFn(); }

function setupPending() {
  try { return fs.existsSync(SETUP_PENDING); } catch (e) { return false; }
}

/*
 * Settings the dashboard is allowed to write. Everything else in config.json
 * (port, host, allowControl, allowPower, token) stays file-only: those decide
 * who may reach this server at all, and a UI that can widen its own exposure
 * defeats the point of setting them. The one exception is host, from the TV
 * itself during setup - see setNetworkAccess.
 */
function readConfigFile() {
  try {
    if (configFilePath && fs.existsSync(configFilePath)) {
      return JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
  } catch (e) {
    console.error('warning: could not re-read ' + configFilePath + ': ' + e.message);
  }
  return {};
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

/*
 * A topic segment ends up in every topic this bridge publishes. MQTT wildcards
 * and a trailing slash would produce topics Home Assistant silently never
 * matches, which looks like a broken bridge rather than a bad prefix.
 */
function badTopic(v) {
  return !v || /[#+\s]/.test(v) || v.charAt(0) === '/' || v.charAt(v.length - 1) === '/';
}

function validateSettings(j) {
  var m = (j && j.mqtt) || {};
  var d = (j && j.device) || {};
  var out = { mqtt: {}, device: {} }, e = [];

  out.mqtt.enabled = !!m.enabled;
  out.mqtt.host = str(m.host);
  if (out.mqtt.enabled && !out.mqtt.host) e.push('a broker address is required to enable MQTT');

  if (m.port === null || m.port === undefined || m.port === '') {
    out.mqtt.port = null;
  } else {
    var port = parseInt(m.port, 10);
    if (!(port >= 1 && port <= 65535)) e.push('port must be between 1 and 65535');
    else out.mqtt.port = port;
  }

  out.mqtt.tls = !!m.tls;
  out.mqtt.tlsRejectUnauthorized = m.tlsRejectUnauthorized !== false;
  out.mqtt.username = str(m.username);

  /*
   * The password is never sent to the browser, so an absent field means
   * "unchanged" rather than "clear it". Clearing needs an explicit "".
   */
  if (typeof m.password === 'string') out.mqtt.password = m.password;

  out.mqtt.topicPrefix = str(m.topicPrefix) || 'lgtv';
  if (badTopic(out.mqtt.topicPrefix)) e.push('topic prefix cannot contain +, # or spaces, or start or end with /');
  out.mqtt.discoveryPrefix = str(m.discoveryPrefix) || 'homeassistant';
  if (badTopic(out.mqtt.discoveryPrefix)) e.push('discovery prefix cannot contain +, # or spaces, or start or end with /');

  var iv = parseInt(m.telemetryIntervalMs, 10);
  if (!(iv >= 1000 && iv <= 600000)) e.push('telemetry interval must be between 1000 and 600000 ms');
  else out.mqtt.telemetryIntervalMs = iv;

  out.mqtt.entities = {};
  var me = (m && m.entities) || {};
  for (var c = 0; c < HA_CATEGORIES.length; c++) {
    var cat = HA_CATEGORIES[c].id;
    out.mqtt.entities[cat] = typeof me[cat] === 'boolean' ? me[cat] : true;
  }
  out.mqtt.entities.disabled = Array.isArray(me.disabled) ? me.disabled.filter(function (id) {
    return typeof id === 'string' && /^[a-z0-9_.]{1,64}$/.test(id);
  }) : [];

  /*
   * The device id keys every discovery topic and every entity id in Home
   * Assistant. Changing it orphans the old entities rather than renaming them.
   */
  out.device.id = str(d.id);
  if (!/^[a-z0-9_]{1,64}$/.test(out.device.id)) e.push('device id must be 1-64 characters of a-z, 0-9 or _');
  out.device.name = str(d.name);

  return { errors: e, value: out };
}

function writeSettings(patch, cb) {
  var file = readConfigFile();
  for (var section in patch) {
    file[section] = file[section] || {};
    for (var k in patch[section]) file[section][k] = patch[section][k];
  }
  try {
    if (!configFilePath) return cb(new Error('no config file path configured'));
    var tmp = configFilePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.chmodSync(tmp, parseInt('600', 8));
    fs.renameSync(tmp, configFilePath);   // atomic: never leave a half-written config
  } catch (err) {
    return cb(err);
  }
  cb(null);
}

/*
 * host is file-only everywhere else so a page cannot widen its own exposure.
 * This is the one writer, and only the TV can reach it.
 */
function setNetworkAccess(open, cb) {
  var file = readConfigFile();
  file.host = open ? '0.0.0.0' : '127.0.0.1';
  try {
    if (!configFilePath) return cb(new Error('no config file path configured'));
    var tmp = configFilePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.chmodSync(tmp, parseInt('600', 8));
    fs.renameSync(tmp, configFilePath);
  } catch (err) { return cb(err); }
  cb(null);
}

// The TV's own address on the home network, whatever the server is bound to.
function lanAddress() {
  var ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch (e) { return null; }
  var best = null;
  for (var name in ifaces) {
    if (!ifaces.hasOwnProperty(name)) continue;
    var list = ifaces[name] || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var fam = String(a.family);
      if (fam !== 'IPv4' && fam !== '4') continue;
      if (a.internal) continue;
      // Wired first where a TV has both, otherwise the first that answers.
      if (!best || /^eth/.test(name)) best = a.address;
    }
  }
  return best;
}

// Whether the dashboard answers on the network, or only on the TV itself.
function networkOpen() {
  return !/^(127\.|::1$|localhost$)/.test(String(config.host));
}

/*
 * The address a phone on the same network can reach this server at. The TV app
 * only ever sees localhost, so it cannot work this out for itself, and a QR
 * code of "localhost" would be useless to the person holding the phone.
 */
function lanOrigin() {
  // Bound to loopback, the server answers nothing on the network, so any LAN
  // address handed to a phone would be a dead link.
  if (!networkOpen()) return null;
  var ip = lanAddress();
  return ip ? 'http://' + ip + ':' + config.port : null;
}

function handoffPort() { return (config.port || 8080) + 1; }

function stopHandoff() {
  if (HANDOFF.timer) clearTimeout(HANDOFF.timer);
  if (HANDOFF.server) { try { HANDOFF.server.close(); } catch (e) {} }
  HANDOFF.server = HANDOFF.code = HANDOFF.timer = null;
}

function handoffUrl() {
  var ip = lanAddress();
  return ip && HANDOFF.code ? 'http://' + ip + ':' + handoffPort() + '/?c=' + HANDOFF.code : null;
}

/*
 * A TV set up from a phone has had no chance to pick a device id or topic
 * prefix, and the defaults are the same on every TV: a second TV would take
 * over the first one's entities in Home Assistant. So one that has neither
 * saved gets its own, from its model and the end of its network address, which
 * also tells two TVs of the same model apart.
 */
function ownIdentity() {
  var file = readConfigFile();
  var fm = file.mqtt || {};
  // One already set up keeps what it has, defaults included: its entities in
  // Home Assistant are named from it.
  if ((file.device && file.device.id) || fm.topicPrefix || fm.host) return null;
  var model = String((config.device && config.device.model) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!model || model === 'webostv') model = 'tv';
  var mac = '', ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch (e) {}
  var ip = lanAddress();
  for (var name in ifaces) {
    (ifaces[name] || []).forEach(function (a) { if (a.address === ip && a.mac) mac = a.mac; });
  }
  var tail = mac.replace(/[^0-9a-f]/gi, '').slice(-4).toLowerCase();
  var key = (model + (tail ? '_' + tail : '')).slice(0, 40);
  return { id: 'lg_' + key, prefix: 'lgtv_' + key };
}

function setupState() {
  var m = config.mqtt || {};
  var mqttStat = getMqttStatus();
  return {
    ok: true,
    needed: setupPending(),
    writable: config.allowControl,
    network: networkOpen(),
    token: !!config.token,
    address: lanAddress() ? lanAddress() + ':' + config.port : null,
    homeAssistant: { configured: !!(m.enabled && m.host), state: mqttStat.state },
    handoff: HANDOFF.server ? handoffUrl() : null
  };
}

function startHandoff(cb) {
  if (HANDOFF.server) return cb(null, handoffUrl());
  if (!lanAddress()) return cb(new Error('this TV has no network address'));
  var code = crypto.randomBytes(8).toString('hex');
  var srv = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (!HANDOFF.code || u.query.c !== HANDOFF.code) {
      return send(res, 403, 'This link has expired. Start again on the TV.', 'text/plain; charset=utf-8');
    }
    if (u.pathname === '/' && req.method === 'GET') {
      var page = assetPath('setup-phone.html');
      if (!page) return send(res, 404, 'setup page missing', 'text/plain');
      return fs.readFile(page, function (err, buf) {
        if (err) return send(res, 500, 'could not read the setup page', 'text/plain');
        send(res, 200, buf, 'text/html; charset=utf-8');
      });
    }
    if (u.pathname === '/mqtt' && req.method === 'POST') {
      if (String(req.headers['content-type'] || '').indexOf('application/json') !== 0) {
        return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
      }
      var body = '';
      req.on('data', function (d) { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', function () {
        var p = null;
        try { p = JSON.parse(body); } catch (e) {
          return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
        }
        // The phone supplies the broker; everything else keeps its current value.
        var cur = config.mqtt || {}, dev = config.device || {};
        var own = ownIdentity();
        var v = validateSettings({
          mqtt: {
            enabled: true, host: p.host, port: p.port, tls: !!p.tls,
            tlsRejectUnauthorized: cur.tlsRejectUnauthorized !== false,
            username: p.username, password: typeof p.password === 'string' ? p.password : '',
            topicPrefix: own ? own.prefix : cur.topicPrefix, discoveryPrefix: cur.discoveryPrefix,
            telemetryIntervalMs: cur.telemetryIntervalMs || 10000, entities: cur.entities
          },
          device: own ? { id: own.id, name: dev.name } : { id: dev.id, name: dev.name }
        });
        if (v.errors.length) {
          return send(res, 400, JSON.stringify({ ok: false, error: v.errors.join('; ') }));
        }
        writeSettings(v.value, function (err) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: msg('srv.saveSettingsFailed', 'could not save the settings') }));
          console.log('setup: Home Assistant broker set from a phone, restarting to connect');
          send(res, 200, JSON.stringify({ ok: true }));
          stopHandoff();   // the code is spent
          setTimeout(function () { restartSelf(); }, 300);
        });
      });
      return;
    }
    send(res, 404, 'not found', 'text/plain');
  });
  srv.on('error', function (err) {
    console.error('setup: could not open the phone link: ' + err.message);
    stopHandoff();
  });
  srv.listen(handoffPort(), '0.0.0.0', function () {
    HANDOFF.server = srv;
    HANDOFF.code = code;
    HANDOFF.timer = setTimeout(stopHandoff, HANDOFF_MS);
    cb(null, handoffUrl());
  });
}

/*
 * Shown in place of the dashboard when its asset is missing. Deliberately
 * plain and self-contained: it names what is absent and where it was looked
 * for, because the fix is a redeploy and the reader needs to know that rather
 * than be shown numbers. The API and the MQTT bridge are unaffected, so it
 * says that too before anyone assumes the whole server is down.
 */
function missingAssetsPage() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Glasshouse &middot; dashboard assets missing</title>',
    '<style>',
    'body{background:#000;color:rgba(255,255,255,.8);margin:0;padding:8vw 6vw;',
    '  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'h1{font-size:19px;font-weight:500;color:#fff;margin:0 0 18px}',
    'p{margin:0 0 14px;max-width:62ch}',
    'code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:3px;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}',
    'ul{margin:0 0 14px;padding-left:20px}',
    '.dim{color:rgba(255,255,255,.5);font-size:13px}',
    '</style></head><body>',
    '<h1>Dashboard assets are missing</h1>',
    '<p><code>ui.html</code> was not found. The server is running normally &mdash;',
    'the JSON API and the Home Assistant MQTT bridge are unaffected &mdash; but it',
    'has no dashboard to serve.</p>',
    '<p>Looked in:</p><ul>',
    assetDirsList.map(function (d) {
      return '<li><code>' + d.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></li>';
    }).join(''),
    '</ul>',
    '<p>Deploying again restores it: <code>./server/deploy.sh &lt;tv-ip&gt;</code>.</p>',
    '<p class="dim">tvweb ' + versionStr + '</p>',
    '</body></html>'
  ].join('\n');
}

// Called only where something will serve it: not with the web dashboard off,
// nor for a one-shot run such as --update.
function loadUI() {
  var f = assetPath('ui.html');
  if (!f) {
    console.error('assets: ui.html not found in ' + assetDirsList.join(', ') +
                  ' - the dashboard will report it is missing');
    return;
  }
  try {
    UI_HTML = fs.readFileSync(f, 'utf8');
    console.log('assets: serving ui.html from ' + f);
    /*
     * On this thread rather than zlib's worker pool. Node 0.12's process
     * spawning can deadlock (see lunaCached), and startup launches luna-send
     * repeatedly while an async compression would still be running: the one
     * startup seen to stall, on a B8 straight after an update, stopped with
     * this compression unfinished.
     */
    try {
      UI_HTML_GZ = zlib.gzipSync(UI_HTML);
      console.log('assets: pre-compressed ui.html (' + UI_HTML.length + ' -> ' + UI_HTML_GZ.length + ' bytes)');
    } catch (ze) {}
  } catch (e) {
    console.error('assets: could not read ui.html: ' + e.message);
  }
}

// ---------------------------------------------------------------- server
// The TV's own software updates sit beside Glasshouse's in both dashboards.
function updateSummary() {
  var s = updaterModule.updateSummary();
  s.tvUpdatesBlocked = privacyModule.tvUpdatesBlocked();
  return s;
}

function send(res, code, body, type) {
  if (!type || type.indexOf('application/json') === 0) {
    body = say.translateBody(body, res && res.glasshouseLang);
  }
  /*
   * No Access-Control-Allow-Origin. The telemetry includes what is currently
   * playing, the model, panel hours and usage, and a wildcard here let any
   * site the user happened to visit read all of it from their browser. The
   * dashboard is same-origin, so it needs no CORS grant.
   */
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function authed(q, req) {
  if (!config.token) return true;
  if (q && q.k === config.token) return true;
  // The on-TV dashboard app fetches from localhost and has no way to carry a
  // token (there is no login prompt on a TV remote).  A process on the TV
  // already has root, so the token adds nothing for local requests.
  return !!(req && fromTV(req));
}

// A request made on the TV itself - the on-TV app, or anything else running
// there, which has root already. Nothing on the network can present as this.
function fromTV(req) {
  var ra = (req && req.connection && req.connection.remoteAddress) ||
           (req && req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function readJsonBody(req, res, cb) {
  /*
   * CSRF guard. No CORS grant is sent, so another site cannot read the
   * reply - but a POST with a "simple" content type (text/plain,
   * form-urlencoded) is still *delivered* without a preflight, and the TV
   * has acted on it by the time the response is discarded. Requiring
   * application/json forces a preflight, which this server never approves,
   * and rejecting cross-site Origins closes the gap for anything that does
   * slip through.
   */
  var ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (ctype.indexOf('application/json') !== 0) {
    return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
  }
  var origin = req.headers.origin;
  if (origin) {
    var hostHdr = String(req.headers.host || '');
    var oHost = String(origin).replace(/^https?:\/\//, '');
    if (oHost !== hostHdr) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
  }
  var body = '';
  req.on('data', function (d) {
    body += d;
    if (body.length > 8192) req.destroy();
  });
  req.on('end', function () {
    var j = {};
    try { j = JSON.parse(body); } catch (e) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
    }
    cb(j);
  });
}

function handleRequest(req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname;
  /** @type {any} */ (res).glasshouseLang = say.langOf(req);

  if (pathname === '/' || pathname === '/index.html') {
    if (UI_HTML) {
      var enc = req.headers['accept-encoding'] || '';
      if (UI_HTML_GZ && enc.indexOf('gzip') !== -1) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': UI_HTML_GZ.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        return res.end(UI_HTML_GZ);
      }
      return send(res, 200, UI_HTML, 'text/html; charset=utf-8');
    }
    // 503, not 200: the dashboard is genuinely unavailable, and a monitor
    // polling this should see that rather than a page that says so in prose.
    return send(res, 503, missingAssetsPage(), 'text/html; charset=utf-8');
  }

  if (pathname.indexOf('/assets/') === 0) {
    var file = assetPath(pathname.slice('/assets/'.length));
    if (!file) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    var ext = path.extname(file).toLowerCase();
    var mime = MIME[ext] || 'application/octet-stream';
    // The strings and their translations change with each release as the pages
    // do, so a day-old copy beside a new page would show text the page no
    // longer has, or miss text it now does.
    var fresh = ext === '.html' || ext === '.json' || /(^|\/)i18n\.js$/.test(file);
    var cacheHdr = fresh ? 'no-cache' : 'public, max-age=86400';
    if (ASSET_CACHE[file]) {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': ASSET_CACHE[file].length,
        'Cache-Control': cacheHdr
      });
      return res.end(ASSET_CACHE[file]);
    }
    return fs.readFile(file, function (e, buf) {
      if (e) return send(res, 500, JSON.stringify({ ok: false, error: 'read failed' }));
      ASSET_CACHE[file] = buf;
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Cache-Control': cacheHdr
      });
      res.end(buf);
    });
  }

  if (pathname.indexOf('/api/') === 0 && !authed(u.query, req)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (pathname === '/api/caps') {
    var caps = {
      ok: true, allowControl: config.allowControl, allowPower: config.allowPower,
      origin: lanOrigin(), version: versionStr,
      fromHomebrewChannel: fromHomebrewChannel(), setupNeeded: setupPending()
    };
    // The token goes into the TV's QR codes, so a phone that scans one can use
    // what it opens. Only to the TV itself: whoever sees the screen holds the
    // remote, and the remote needs no token.
    if (config.token && fromTV(req)) caps.key = config.token;
    return send(res, 200, JSON.stringify(caps));
  }

  if (pathname === '/api/screensaver') {
    return send(res, 200, JSON.stringify(screensaversModule.screensaverList()));
  }

  if (pathname === '/api/hdmi') {
    return telemetryModule.hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/servicemenu') {
    return oledModule.serviceMenuState(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  // First-run setup and the TV's own settings. The TV only: see fromTV.
  if (pathname === '/api/setup') {
    if (!fromTV(req)) return send(res, 403, JSON.stringify({ ok: false, error: 'only from the TV itself' }));
    if (req.method === 'GET') {
      /*
       * Setup offers Always-on only on a TV that has it (a C2 on webOS 9.2
       * does, a B8 on 4.4 does not), so the TV is asked here; a TV without the
       * setting answers with an error, and the step is left out.
       */
      return luna('com.webos.service.settings/getSystemSettings',
                  { category: 'general', keys: ['alwaysOn'] }, function (r) {
        var st = setupState();
        var ar = r && r.returnValue !== false && r.settings && r.settings.alwaysOn;
        if (ar !== undefined && ar !== null) st.alwaysReady = ar === 'on' || ar === true;
        send(res, 200, JSON.stringify(st));
      });
    }
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'GET or POST' }));
    if (String(req.headers['content-type'] || '').toLowerCase().indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var stBody = '';
    req.on('data', function (d) { stBody += d; if (stBody.length > 1024) req.destroy(); });
    req.on('end', function () {
      var a = null;
      try { a = JSON.parse(stBody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      if (!config.allowControl && a.action !== 'done') {
        return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
      }
      if (a.action === 'network') {
        var open = !!a.open;
        if (open === networkOpen()) return send(res, 200, JSON.stringify({ ok: true, restarting: false }));
        return setNetworkAccess(open, function (err) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: msg('srv.saveSettingFailed.plain', 'could not save the setting') }));
          console.log('setup: dashboard ' + (open ? 'opened to the network' : 'closed to this TV') + ', restarting');
          /*
           * Answer before restarting: the restart kills this process, and the
           * browser needs the result to know the save itself succeeded.
           */
          send(res, 200, JSON.stringify({ ok: true, restarting: true }));
          setTimeout(function () { restartSelf(); }, 250);
        });
      }
      if (a.action === 'alwaysReady') {
        return doControl('alwaysReady', !!a.on, function (r) {
          send(res, r && r.ok ? 200 : 500, JSON.stringify(r && r.ok ? { ok: true } : { ok: false, error: msg('srv.tvRefused', 'the TV would not change it') }));
        });
      }
      if (a.action === 'handoff') {
        return startHandoff(function (err, link) {
          if (err) return send(res, 500, JSON.stringify({ ok: false, error: err.message }));
          send(res, 200, JSON.stringify({ ok: true, url: link }));
        });
      }
      if (a.action === 'handoffStop') {
        stopHandoff();
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (a.action === 'done') {
        try { fs.unlinkSync(SETUP_PENDING); } catch (e) {}
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      send(res, 400, JSON.stringify({ ok: false, error: 'unknown action' }));
    });
    return;
  }

  if (pathname === '/api/tvapp') {
    return tvApp('status', function (r) {
      if (r && r.ok) r.writable = config.allowControl;
      send(res, 200, JSON.stringify(r));
    });
  }

  if (pathname === '/api/oledcare') {
    return oledModule.readOledProtections(function (live) {
      telemetryModule.collectStats(function (st) {
        var oledData = (st && st.oled) || {};
        send(res, 200, JSON.stringify({
          ok: true,
          isOled: !!(st && st.oled),
          // Whether this TV has the service the service menu goes through.
          serviceControls: oledModule.oledProtControllable(),
          writable: config.allowControl,
          /*
           * null where the TV says nothing. Without the service, all there is
           * are the marker files, and a TV that writes none of them - a B8
           * writes neither - has not said these are off, only that it does not
           * report them.
           */
          gsr: live ? live.gsr : (oledData.gsr_protection ? oledData.gsr_protection === 'Active' : null),
          tpc: live ? live.tpc : (oledData.asbl_protection ? oledData.asbl_protection === 'Active' : null),
          gsrStressCount: live ? live.gsrStressCount : null,
          screenShift: oledData.screen_shift || null,
          logoDimming: oledData.logo_dimming || null,
          // The panel's own wear figures, which belong beside the switches
          // that decide how hard it is worked.
          panelHours: (oledData.panel_hours === undefined) ? null : oledData.panel_hours,
          hoursUntilComp: (oledData.hours_until_comp === undefined) ? null : oledData.hours_until_comp,
          hoursUntilRefresher: (oledData.hours_until_refresher === undefined) ? null : oledData.hours_until_refresher,
          compStatus: oledData.comp_status || null,
          refresherStatus: oledData.refresher_status || null,
          compCycles: (oledData.comp_cycles === undefined) ? null : oledData.comp_cycles,
          refresherCycles: (oledData.refresher_cycles === undefined) ? null : oledData.refresher_cycles,
          failureAlerts: (oledData.failure_alerts === undefined) ? null : oledData.failure_alerts
        }));
      });
    });
  }

  if (pathname === '/api/cpu') {
    return telemetryModule.collectCpuProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    return telemetryModule.collectProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  // LG's Game Optimizer settings, for the game input and genre in use, and
  // the picture mode, since LG applies them only in its Game Optimizer mode.
  if (pathname === '/api/game') {
    return lgSettingsModule.collect('game', function (g) {
      if (!g.rows.length) return send(res, 200, JSON.stringify({ ok: true, available: false }));
      lunaFn('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode'] }, function (p) {
        send(res, 200, JSON.stringify({
          ok: true, available: true, rows: g.rows,
          input: g.dimensions.other ? g.dimensions.other.gameInput : null,
          pictureMode: (p && p.settings && p.settings.pictureMode) || null
        }));
      });
    });
  }

  // Polled once a second while the Game tab is open; see game.js. The input's
  // pipeline keeps running, and reporting, behind an app, so a reading counts
  // only while that input is the app on screen.
  if (pathname === '/api/game/fps') {
    var fps = gameModule.frameRate();
    return lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var onScreen = !!(fps.port && fg && fg.appId === 'com.webos.app.' + fps.port.toLowerCase());
      send(res, 200, JSON.stringify({ ok: true, fps: onScreen ? fps : { frameRate: 0, vrrType: 'off', port: null } }));
    });
  }

  if (pathname === '/api/privacy') {
    return privacyModule.collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (pathname === '/api/apps' && req.method === 'GET') {
    return appsModule.getApps(function (d) {
      d.tileHidingAvailable = !fromHomebrewChannel();
      if (!d.tileHidingAvailable) { d.systemTiles = []; d.tileHidingEnabled = false; d.hiddenCount = 0; }
      servicesModule.getServices(function (sRes) {
        if (sRes && sRes.services) d.services = sRes.services;
        send(res, 200, JSON.stringify(d));
      });
    });
  }

  if (pathname === '/api/apps/icon' && (req.method === 'GET' || req.method === 'HEAD')) {
    var iconAppId = u.query && u.query.id;
    return appsModule.getIconPath(iconAppId, function (iconPath) {
      if (!iconPath) return send(res, 404, JSON.stringify({ ok: false, error: 'icon not found' }));
      fs.stat(iconPath, function (err, st) {
        if (err || !st) return send(res, 404, JSON.stringify({ ok: false, error: 'icon read failed' }));
        var headers = {
          'Content-Type': 'image/png',
          'Content-Length': st.size,
          'Cache-Control': 'public, max-age=86400'
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, headers);
          return res.end();
        }
        fs.readFile(iconPath, function (readErr, buf) {
          if (readErr || !buf) return send(res, 500, JSON.stringify({ ok: false, error: 'icon read failed' }));
          res.writeHead(200, headers);
          res.end(buf);
        });
      });
    });
  }

  if (pathname === '/api/apps/add-page' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.addSavedPage(body && body.address, body && body.title, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/remove-page' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.removeSavedPage(body && body.launchPointId, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  // /api/apps/rename is the name it had in 0.55.0, when only the title changed.
  if ((pathname === '/api/apps/edit-page' || pathname === '/api/apps/rename') && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.editSavedPage(body && body.launchPointId, body && body.title, body && body.address, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/uninstall' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.uninstallApp(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if ((pathname === '/api/apps/hide' || pathname === '/api/apps/unhide') && fromHomebrewChannel()) {
    return send(res, 400, JSON.stringify({ ok: false, error: tileHidingOffMsg }));
  }
  if (pathname === '/api/apps/hide' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.hideTile(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/unhide' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.unhideTile(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/unhide-all' && req.method === 'POST') {
    return readJsonBody(req, res, function () {
      appsModule.unhideAllTiles(function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/apps/tile-hiding' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.setTileHidingEnabled(body && body.enabled, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    return servicesModule.getServices(function (d) { send(res, 200, JSON.stringify(d)); });
  }

  if (pathname === '/api/services/toggle' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      servicesModule.toggleService(body && body.id, !!(body && body.disabled), function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
  }

  if (pathname === '/api/stats') {
    return telemetryModule.collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  /* Reports what is known, and never checks on its own: the dashboard polls
     this, and a poll that reached GitHub would be a request per viewer. */
  if (pathname === '/api/update') {
    return send(res, 200, JSON.stringify(updateSummary()));
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    var mc = config.mqtt || {};
    var mqttStat = getMqttStatus();
    return send(res, 200, JSON.stringify({
      ok: true,
      writable: config.allowControl,
      configFile: configFilePath,
      mqtt: {
        enabled: !!mc.enabled,
        host: mc.host || '',
        port: mc.port === undefined ? null : mc.port,
        tls: !!mc.tls,
        tlsRejectUnauthorized: mc.tlsRejectUnauthorized !== false,
        username: mc.username || '',
        // The password is deliberately not returned; only whether one is set.
        passwordSet: !!mc.password,
        topicPrefix: mc.topicPrefix || 'lgtv',
        discoveryPrefix: mc.discoveryPrefix || 'homeassistant',
        telemetryIntervalMs: mc.telemetryIntervalMs || 10000,
        entities: {
          controls: !mc.entities || mc.entities.controls !== false,
          oled: !mc.entities || mc.entities.oled !== false,
          video: !mc.entities || mc.entities.video !== false,
          system: !mc.entities || mc.entities.system !== false,
          diagnostics: !mc.entities || mc.entities.diagnostics !== false,
          disabled: (mc.entities && Array.isArray(mc.entities.disabled)) ? mc.entities.disabled : []
        },
        categories: HA_CATEGORIES,
        entityCatalogue: HA_ENTITIES
      },
      device: {
        id: (config.device && config.device.id) || '',
        name: (config.device && config.device.name) || ''
      },
      /* Ages rather than timestamps: the TV's clock is often minutes off the
         browser's, and a negative "last publish" reads as a fault. */
      status: {
        state: mqttStat.state,
        broker: mqttStat.broker,
        tls: mqttStat.tls,
        detail: mqttStat.detail,
        forMs: Date.now() - (mqttStat.since || Date.now()),
        lastPublishMs: mqttStat.lastPublish ? Date.now() - mqttStat.lastPublish : null
      }
    }));
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    if (!config.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') }));
    }
    var sctype = String(req.headers['content-type'] || '').toLowerCase();
    if (sctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
    }
    var sorigin = req.headers.origin;
    if (sorigin && String(sorigin).replace(/^https?:\/\//, '') !== String(req.headers.host || '')) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
    var sbody = '';
    req.on('data', function (d) {
      sbody += d;
      if (sbody.length > 8192) req.destroy();
    });
    req.on('end', function () {
      var j = null;
      try { j = JSON.parse(sbody); } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'malformed JSON' }));
      }
      var v = validateSettings(j);
      if (v.errors.length) {
        return send(res, 400, JSON.stringify({ ok: false, error: v.errors.join('; ') }));
      }
      writeSettings(v.value, function (err) {
        if (err) {
          return send(res, 500, JSON.stringify({ ok: false, error: 'could not write ' + configFilePath + ': ' + err.message }));
        }
        console.log('settings: saved to ' + configFilePath + ', restarting to apply');
        send(res, 200, JSON.stringify({ ok: true, restarting: true }));
        setTimeout(function () {
          if (!restartSelf()) console.error('settings: no tvwebctl found - restart manually to apply');
        }, 250);
      });
    });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    var ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({
        ok: false, error: 'Content-Type must be application/json'
      }));
    }
    var origin = req.headers.origin;
    if (origin) {
      var hostHdr = String(req.headers.host || '');
      var oHost = String(origin).replace(/^https?:\/\//, '');
      if (oHost !== hostHdr) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
      }
    }
    var body = '';
    req.on('data', function (d) {
      body += d;
      if (body.length > 4096) req.destroy();   // do not buffer junk
    });
    req.on('end', function () {
      var j = {};
      try { j = JSON.parse(body); } catch (e) {}
      doControl(j.action, j.value, function (r) { send(res, 200, JSON.stringify(r)); });
    });
    return;
  }

  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
}

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.configFile) configFilePath = opts.configFile;
  if (opts.controls) controlsModule = opts.controls;
  if (opts.telemetry) telemetryModule = opts.telemetry;
  if (opts.oled) oledModule = opts.oled;
  if (opts.privacy) privacyModule = opts.privacy;
  if (opts.lgSettings) lgSettingsModule = opts.lgSettings;
  if (opts.game) gameModule = opts.game;
  if (opts.apps) appsModule = opts.apps;
  if (opts.services) servicesModule = opts.services;
  if (opts.screensavers) screensaversModule = opts.screensavers;
  if (opts.updater) updaterModule = opts.updater;
  if (opts.tvApp) tvAppFn = opts.tvApp;
  if (opts.restartSelf) restartSelfFn = opts.restartSelf;
  if (opts.fromHomebrewChannel) fromHbcFn = opts.fromHomebrewChannel;
  if (opts.tileHidingOff) tileHidingOffMsg = opts.tileHidingOff;
  if (opts.assetPath) assetPathFn = opts.assetPath;
  if (opts.assetDirs) assetDirsList = opts.assetDirs;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.getMqttStatus) getMqttStatusFn = opts.getMqttStatus;
  if (opts.version) versionStr = opts.version;

  return {
    handleRequest: handleRequest,
    send: send,
    readJsonBody: readJsonBody,
    authed: authed,
    fromTV: fromTV,
    validateSettings: validateSettings,
    writeSettings: writeSettings,
    readConfigFile: readConfigFile,
    lanAddress: lanAddress,
    networkOpen: networkOpen,
    lanOrigin: lanOrigin,
    setupPending: setupPending,
    setupState: setupState,
    startHandoff: startHandoff,
    stopHandoff: stopHandoff,
    setNetworkAccess: setNetworkAccess,
    loadUI: loadUI
  };
}

module.exports = {
  init: init,
  handleRequest: handleRequest,
  send: send,
  readJsonBody: readJsonBody,
  authed: authed,
  fromTV: fromTV,
  validateSettings: validateSettings,
  writeSettings: writeSettings,
  readConfigFile: readConfigFile,
  setNetworkAccess: setNetworkAccess,
  lanAddress: lanAddress,
  networkOpen: networkOpen,
  lanOrigin: lanOrigin,
  setupPending: setupPending,
  setupState: setupState,
  startHandoff: startHandoff,
  stopHandoff: stopHandoff,
  loadUI: loadUI,
  updateSummary: updateSummary,
  missingAssetsPage: missingAssetsPage,
  MIME: MIME
};
