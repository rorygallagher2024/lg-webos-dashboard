/*
 * tvweb.js - on-TV monitor + control web server for a rooted LG webOS TV.
 * Verified on OLED65B8SLC / webOS 4.4.3.
 *
 * IMPORTANT: the TV ships node v0.12.2 (2015). This file must stay ES5 -
 * no arrow functions, no const/let, no template literals, no async/await,
 * no Object.assign; scripts/check-es5.py enforces it. The dashboard in
 * assets/ui.html is NOT restricted: it runs in a browser, not on the TV.
 *
 * Run:  node tvweb.js
 */

var http = require('http');
var fs = require('fs');
var url = require('url');
var net = require('net');
var tls = require('tls');
var child_process = require('child_process');
var os = require('os');
var crypto = require('crypto');
var path = require('path');
var execFile = child_process.execFile;
var zlib = require('zlib');
var MiniMQTT = require('./lib/mqtt');
var ha = require('./lib/ha');
var updater = require('./lib/updater');
var privacy = require('./lib/privacy');
var oled = require('./lib/oled');
var screensavers = require('./lib/screensavers');
var appsModule = require('./lib/apps');
var servicesModule = require('./lib/services');
var telemetry = require('./lib/telemetry');
var controls = require('./lib/controls');
var routes = require('./lib/routes');
var stateModule = require('./lib/state');
var mqttStateModule = require('./lib/mqtt-state');
var notifications = require('./lib/notifications');
var lunaTransport = require('./lib/luna');
var say = require('./lib/say');
var lgSettings = require('./lib/lgsettings');
var game = require('./lib/game');
var msg = say.msg;
var luna = lunaTransport.call;

/*
 * Bump on release, and tag the release to match: the dashboard turns this into
 * a link to /releases/tag/v<version>, so a value with no tag behind it gives a
 * 404 rather than a wrong page.
 */
var TVWEB_VERSION = '0.66.0';

// ---------------------------------------------------------------- config
/** @type {any} */
var CONFIG = {
  // The dashboard. Turn this off if you drive everything from Home Assistant:
  // it is an unauthenticated control endpoint unless `token` is set, and an
  // MQTT-only install has no reason to expose one.  { "web": { "enabled": false } }
  web: { enabled: true },

  port: 8080,           // dashboard port
  host: '0.0.0.0',      // '127.0.0.1' to keep it TV-local only

  // Anyone who can reach this port can use the controls below.
  allowControl: true,   // volume, screen off/on, input switching, toast

  // Power off / reboot ship DISABLED, because there is no authentication
  // unless `token` is set and a fresh install should not expose "turn the TV
  // off" to the whole network. Enable in your own config.json:
  //     { "allowPower": true }
  allowPower: false,

  // Optional shared secret. If non-empty, every /api/ request must carry
  // ?k=<token>. Keeps casual LAN devices out.
  token: '',

  // Home Assistant & MQTT Integration
  mqtt: {
    // Off until a broker is configured. Shipping an address here would point
    // every install at whatever happens to be at that IP on the user's LAN.
    enabled: false,
    host: '',
    // null means "pick by transport": 1883 plain, 8883 with tls. A literal
    // 1883 here would survive the config merge and silently defeat that.
    port: null,
    // Encrypt the broker connection. Without this the username and password
    // cross the network in cleartext. Port defaults to 8883 when enabled.
    tls: false,
    tlsRejectUnauthorized: true,
    username: '',
    password: '',
    topicPrefix: 'lgtv',
    discoveryPrefix: 'homeassistant',
    telemetryIntervalMs: 10000,
    entities: {
      controls: true,
      oled: true,
      video: true,
      system: true,
      diagnostics: true,
      disabled: []
    }
  },

  device: {
    id: 'lg_tv',
    name: '',
    model: '',
    manufacturer: 'LG'
  },

  /*
   * Release checks. Off by default: this is the only thing here that makes the
   * TV talk to anything off the LAN, and a project whose point is reducing what
   * the set reaches out to should not start doing it unasked. The dashboard's
   * Check now button and `tvwebctl update` work either way - those are the
   * owner asking. With this on, the check also feeds Home Assistant's update
   * entity.
   */
  update: {
    check: false,
    intervalHours: 24,
    /*
     * Path to a TLS-capable curl or wget. Normally left blank: the probe looks
     * in the usual places. Set it when a rooted client lives somewhere else.
     */
    client: ''
  }
};

/* Scanned before loadConfig so --config can point at an alternative file:
   handy for a second TV, or for testing without touching the live config. */
function argvConfigPath() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--config' && a[i + 1]) return a[i + 1];
  }
  return null;
}

/*
 * Where a settings write goes. Set to whichever file loadConfig() actually
 * read; when none exists yet (a fresh install) it stays at the install path,
 * so the first save from the dashboard creates the file the boot hook reads.
 */
var CONFIG_FILE = '/var/lib/tvweb/config.json';

function loadConfig() {
  var override = argvConfigPath();
  var paths = override ? [override] : ['/var/lib/tvweb/config.json', './config.json'];
  if (override) CONFIG_FILE = override;
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        var raw = fs.readFileSync(paths[i], 'utf8');
        var userConf = JSON.parse(raw);
        for (var k in userConf) {
          if (typeof userConf[k] === 'object' && userConf[k] !== null && !Array.isArray(userConf[k])) {
            CONFIG[k] = CONFIG[k] || {};
            for (var sk in userConf[k]) {
              CONFIG[k][sk] = userConf[k][sk];
            }
          } else {
            CONFIG[k] = userConf[k];
          }
        }
        if (CONFIG.mqtt) {
          var me = CONFIG.mqtt.entities;
          if (!me || typeof me !== 'object') me = CONFIG.mqtt.entities = {};
          var cats = ['controls', 'oled', 'video', 'system', 'diagnostics'];
          for (var c = 0; c < cats.length; c++) {
            if (typeof me[cats[c]] !== 'boolean') me[cats[c]] = true;
          }
          if (!Array.isArray(me.disabled)) me.disabled = [];
        }
        /*
         * The file holds broker credentials in plaintext. Default webOS perms
         * leave it world-readable (0644), and TV apps run as wam/nobody - so
         * tighten it to owner-only. Note this is mitigation, not a fix: while
         * the homebrew root telnet on port 23 is open, nothing on this TV is
         * secret. Use a dedicated, ACL-restricted broker user.
         */
        try {
          var mode = fs.statSync(paths[i]).mode & parseInt('777', 8);
          if (mode !== parseInt('600', 8)) {
            fs.chmodSync(paths[i], parseInt('600', 8));
            console.log('tightened permissions on ' + paths[i] + ' to 0600');
          }
        } catch (e) {
          console.error('warning: could not chmod ' + paths[i] + ': ' + e.message);
        }
        CONFIG_FILE = paths[i];
        console.log('loaded configuration from ' + paths[i]);
        break;
      }
    } catch (e) {
      console.error('warning: error reading config from ' + paths[i] + ':', e.message);
    }
  }
}
loadConfig();

/*
 * Command-line overrides, applied after the config file so they always win.
 * Mainly so a second instance can be run alongside the live one for preview
 * without stealing its port or double-publishing MQTT discovery:
 *   node tvweb.js --port 8081 --no-mqtt
 */
(function applyArgv() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--port' && a[i + 1]) CONFIG.port = parseInt(a[++i], 10) || CONFIG.port;
    else if (a[i] === '--host' && a[i + 1]) CONFIG.host = a[++i];
    else if (a[i] === '--config') i++;   // consumed before loadConfig
    else if (a[i] === '--no-mqtt') { CONFIG.mqtt = CONFIG.mqtt || {}; CONFIG.mqtt.enabled = false; }
    else if (a[i] === '--no-control') CONFIG.allowControl = false;
  }
})();

/*
 * One-shot modes, behind `tvwebctl update` and `tvwebctl rollback`. They run
 * the updater and exit rather than starting the server, so a release is
 * installed by the same code whether the request came from the dashboard, Home
 * Assistant or a shell - and so an upgrade works on an install with the
 * dashboard switched off and the server not running.
 */
var CLI_MODE = null;
(function cliMode() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--update') CLI_MODE = 'update';
    else if (a[i] === '--check-update') CLI_MODE = 'check';
    else if (a[i] === '--rollback') CLI_MODE = 'rollback';
  }
})();

updater.init({ config: CONFIG, version: TVWEB_VERSION, installDir: __dirname });

// ---------------------------------------------------------------- helpers
function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}
var TOAST_SOURCE = 'com.webos.app.home';
var BROWSER_APP = 'com.webos.app.browser';

/*
/*
 * Cache for luna reads whose answers do not change between dashboard ticks.
 * Every luna() call is a fork+exec, and telemetry made ten of them per
 * collection at a 2s tick - roughly five forks a second with the dashboard
 * open. Node 0.12's spawn path can deadlock under that (see the watchdog note
 * in tvwebctl), so set-and-forget settings are now read once per TTL.
 *
 * Any successful control clears the lot, so a setting the user just changed is
 * never served from cache.
 */
var lunaCache = {};

function lunaCached(uri, payload, ttlMs, cb) {
  var key = uri + '|' + JSON.stringify(payload || {});
  var hit = lunaCache[key];
  if (hit && (Date.now() - hit.t < ttlMs)) return cb(hit.v, hit.raw);
  luna(uri, payload, function (parsed, raw) {
    // Only a real answer is worth pinning; a failed read should be retried.
    if (parsed) lunaCache[key] = { t: Date.now(), v: parsed, raw: raw };
    cb(parsed, raw);
  });
}

function clearLunaCache() { lunaCache = {}; }

/*
 * Power state. tvpower reports the panel separately from the system: a set can
 * be "Active" with the screen lit, or "ScreenOff" with the system running and
 * the panel blanked - which is exactly what the Screen Off control does. The
 * dashboard previously showed neither, so blanking the panel changed nothing
 * on screen and the source kept reading as though something were displayed.
 */
var POWER_STATES = {
  'active':          [msg('srv.power.on', 'On'),          true,  true],
  'on':              [msg('srv.power.on', 'On'),          true,  true],
  'screenoff':       [msg('srv.power.screenOff', 'Screen off'),  true,  false],
  'screensaver':     [msg('srv.power.screenSaver', 'Screen Saver'),true,  true],
  // LG's Always Ready display: switched off, showing a clock or artwork.
  'alwaysready':     [msg('srv.power.alwaysReady', 'Always Ready'), false, false],
  'activestandby':   [msg('srv.power.standby', 'Standby'),     false, false],
  'standby':         [msg('srv.power.standby', 'Standby'),     false, false],
  'suspend':         [msg('srv.power.standby', 'Standby'),     false, false],
  'preparesuspend':  [msg('srv.power.standby', 'Standby'),     false, false],
  'requestpoweroff': [msg('srv.power.off', 'Off'),         false, false],
  'poweroff':        [msg('srv.power.off', 'Off'),         false, false],
  'off':             [msg('srv.power.off', 'Off'),         false, false],
  'prepared':        [msg('srv.power.starting', 'Starting up'), true,  false],
  'processing':      [msg('srv.power.standby', 'Standby'),     false, false]
};

/*
 * Whether a screen saver is on screen. tvpower reports it as a power state of
 * its own, which is the only source that tracks it: the foreground app does
 * not change - the screen saver draws over whatever is running - and the
 * running-apps list keeps the screen saver app long after it has gone.
 *
 * Measured on a B8: "Screen Saver" while one draws, "Active" once a key
 * dismisses it.
 */
function isScreenSaver(ps) {
  return !!(ps && String(ps.raw || '').toLowerCase().replace(/[\s_-]/g, '') === 'screensaver');
}

function mapPowerState(raw) {
  var key = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  var m = POWER_STATES[key];
  if (m) return { raw: raw, label: m[0], systemOn: m[1], screenOn: m[2] };
  // Unknown or absent state: default safely to screen and system off.
  return { raw: raw || null, label: raw || 'Unknown', systemOn: false, screenOn: false };
}

lgSettings.init({ luna: luna, lunaCached: lunaCached, clearLunaCache: clearLunaCache });
privacy.init({ luna: luna, lunaCached: lunaCached, config: CONFIG, lgSettings: lgSettings });
oled.init({ luna: luna, config: CONFIG });
appsModule.init({ luna: luna, config: CONFIG });
servicesModule.init({ stateDir: __dirname });
screensavers.init({
  luna: luna,
  assetPath: assetPath,
  config: CONFIG,
  injectKey: controls.injectKey,
  KEY_BACK: controls.KEY_BACK,
  mapPowerState: mapPowerState,
  isScreenSaver: isScreenSaver
});
telemetry.init({
  luna: luna,
  lunaCached: lunaCached,
  config: CONFIG,
  oled: oled,
  privacy: privacy,
  screensavers: screensavers,
  tvwebVersion: TVWEB_VERSION,
  mapPowerState: mapPowerState,
  isScreenSaver: isScreenSaver,
  services: servicesModule
});

var liveState = stateModule.init({
  inputNameMap: telemetry.inputNameMap,
  mapPowerState: mapPowerState,
  formatSoundOutput: ha.formatSoundOutput,
  clearCache: function () {
    telemetry.clearCache();
    clearLunaCache();
  }
});

var notificationState = notifications.init({ luna: luna });

// ---------------------------------------------------------------- controls
var INPUTS = ha.INPUTS;

// Hiding tiles restarts the app manager at boot, the kind of step that can
// make a boot fail, which the Homebrew Channel asks its apps not to risk.
// Doing it later would let the tiles show after every cold boot, so installs
// from there go without it.
var TILE_HIDING_OFF = 'hiding home-screen tiles is not available when installed from the Homebrew Channel';

controls.init({
  luna: luna,
  clearLunaCache: clearLunaCache,
  config: CONFIG,
  telemetry: telemetry,
  oled: oled,
  privacy: privacy,
  services: servicesModule,
  screensavers: screensavers,
  apps: appsModule,
  lgSettings: lgSettings,
  updater: updater,
  tvApp: tvApp,
  restartSelf: restartSelf,
  updateSummary: routes.updateSummary,
  fromHomebrewChannel: fromHomebrewChannel,
  inputs: INPUTS,
  browserApp: BROWSER_APP,
  toastSource: TOAST_SOURCE,
  tileHidingOff: TILE_HIDING_OFF
});

var doControl = controls.doControl;



// ------------------------------------------------------- external assets
/*
 * The UI is authored as a real HTML file (assets/ui.html) rather than a JS
 * string array, so it can be edited and diffed like a web page.
 *
 * A second complete dashboard used to live here as a fallback for a missing
 * asset. Nothing kept the two in step and it drifted two rewrites behind -
 * different readouts, its own copy of the render logic, no version footer -
 * so the working dashboard it promised was a misleading one, and an install
 * broken in a way nobody would notice. Now a missing asset says so.
 */
var WEB_ENABLED = !(CONFIG.web && CONFIG.web.enabled === false);

var ASSET_DIRS = [
  path.join(__dirname, 'assets'),
  '/var/lib/tvweb/assets'
];

function assetPath(rel) {
  // Reject traversal before touching the filesystem.
  if (rel.indexOf('\0') !== -1) return null;
  var clean = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  if (clean.indexOf('..') !== -1) return null;
  for (var i = 0; i < ASSET_DIRS.length; i++) {
    var full = path.join(ASSET_DIRS[i], clean);
    if (full.indexOf(ASSET_DIRS[i]) !== 0) continue;   // outside the root
    try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; }
    catch (e) {}
  }
  return null;
}

// Translations sit beside the pages, which load the same files.
say.init(path.join(path.dirname(assetPath('i18n.js') || path.join(ASSET_DIRS[0], 'i18n.js')), 'i18n'));

// ---------------------------------------------------------------- TV app
/*
 * The app that puts this dashboard on the TV's own screen. Installing it is a
 * packaging job for shell, so it lives in a script beside the app's files and
 * its result is read back here. An absent script - an older deploy, or a TV
 * that will not take an unsigned app - reports unsupported, and the dashboard
 * hides the control rather than offering something that cannot work.
 */
// Put in place by the app the Homebrew Channel installs, rather than deploy.sh.
var HBC_MARK = '/var/lib/tvweb/.from-homebrew-channel';
function fromHomebrewChannel() {
  try { return fs.existsSync(HBC_MARK); } catch (e) { return false; }
}

/*
 * The Homebrew Channel only replaces or removes the app; the server is ours to
 * keep in step with it. A newer copy inside the app is installed without
 * waiting for someone to open the app, so a TV used only from Home Assistant
 * still updates. An app that has gone takes the server with it.
 *
 * The directory has to be missing on two checks in a row and the app manager
 * has to deny knowing the app before anything is removed: an update in
 * progress can briefly leave the directory absent. The boot hook is a link
 * into the app, so after an uninstall nothing starts at boot even if this
 * never gets to run.
 */
var HBC_APP_DEFAULT = '/media/developer/apps/usr/palm/applications/io.github.rorygallagher2024.lg-webos-dashboard';
var HBC_CHECK_MS = 5 * 60000;
var hbcMissing = 0, hbcTried = null;

function hbcAppDir() {
  var dir = '';
  try { dir = fs.readFileSync(HBC_MARK, 'utf8').trim(); } catch (e) {}
  return dir || HBC_APP_DEFAULT;
}

function checkHomebrewChannelApp() {
  if (!fromHomebrewChannel()) return;
  var dir = hbcAppDir();
  if (fs.existsSync(dir)) {
    hbcMissing = 0;
    var src = '';
    try { src = fs.readFileSync(path.join(dir, 'payload/server/tvweb.js'), 'utf8'); } catch (e) {}
    var m = /^var TVWEB_VERSION = '([^']+)';/m.exec(src);
    var carried = m && m[1];
    if (!carried || carried === hbcTried || !updater.verNewer(carried, TVWEB_VERSION)) return;
    hbcTried = carried;
    console.log('update: the Homebrew Channel app carries v' + carried + ', installing it');
    try {
      child_process.spawn('/bin/sh', [path.join(dir, 'payload/install.sh')], {
        detached: true, stdio: 'ignore'
      }).unref();
    } catch (e) {
      console.error('update: could not run the app\'s installer: ' + e.message);
    }
    return;
  }
  if (!fs.existsSync(path.dirname(dir)) || ++hbcMissing < 2) return;
  // Only the app manager's own "no such app" counts - "Invalid appId
  // specified" on webOS 4.4 and 9.2 alike - never a refusal for another reason
  // such as permissions. Read from the raw reply, since luna-send can exit
  // non-zero on the refusal itself.
  luna('com.webos.applicationManager/getAppInfo', { id: path.basename(dir) }, function (res, raw) {
    try { res = res || JSON.parse(raw); } catch (e) { res = null; }
    if (!res || res.returnValue !== false || !/Invalid appId/i.test(String(res.errorText))) return;
    console.log('uninstall: the Homebrew Channel app is gone, removing the server');
    // Inline rather than a script, since the files it deletes include every
    // script there is. 20-services.sh holds down the services switched off in
    // the dashboard, and they come back once it goes.
    forgetHomeAssistant(function () {
      child_process.spawn('/bin/sh', ['-c',
        '/var/lib/tvweb/tvwebctl stop >/dev/null 2>&1; rm -rf /var/lib/tvweb; ' +
        'cd /var/lib/webosbrew/init.d && rm -f 50-tvweb 20-services.sh 20-tvweb-services; ' +
        'rm -f /var/lib/webosbrew/tvweb-boot.log /var/lib/webosbrew/tvweb-boot.log.old'
      ], { detached: true, stdio: 'ignore' }).unref();
    });
  });
}

function tvApp(action, cb) {
  var script = assetPath('dashboard-app/install-app.sh');
  if (!script) return cb({ ok: true, supported: false, installed: false });
  execFile('/bin/sh', [script, action], { timeout: 90000 }, function (err, stdout) {
    var out = String(stdout || '').trim();
    var last = out.split('\n').pop();
    try { return cb(JSON.parse(last)); }
    catch (e) {
      // install prints a sentence rather than JSON, so read its wording.
      if (action === 'install' || action === 'refresh') {
        return cb({ ok: /added to the home screen/.test(out), refreshed: action === 'refresh' });
      }
      return cb({ ok: !err, error: err ? err.message : 'unreadable result' });
    }
  });
}

// ---------------------------------------------------------------- server
/*
 * MQTT is wired up once at startup - the client, its keepalive, the telemetry
 * timer and every discovery topic close over the config that was current then.
 * Restarting the process is the one way to apply new broker settings that
 * cannot leave a half-migrated bridge behind.
 */
function restartSelf() {
  var ctl = [path.join(__dirname, 'tvwebctl'), '/var/lib/tvweb/tvwebctl'];
  for (var i = 0; i < ctl.length; i++) {
    if (!fs.existsSync(ctl[i])) continue;
    try {
      child_process.spawn('/bin/sh', [ctl[i], 'restart'], {
        detached: true, stdio: 'ignore'
      }).unref();
      return true;
    } catch (e) {
      console.error('restart failed: ' + e.message);
    }
  }
  return false;
}

updater.init({
  config: CONFIG,
  version: TVWEB_VERSION,
  installDir: __dirname,
  writeSettings: routes.writeSettings,
  viaHomebrewChannel: fromHomebrewChannel
});

routes.init({
  config: CONFIG,
  configFile: CONFIG_FILE,
  controls: controls,
  telemetry: telemetry,
  oled: oled,
  privacy: privacy,
  lgSettings: lgSettings,
  game: game,
  apps: appsModule,
  services: servicesModule,
  screensavers: screensavers,
  updater: updater,
  tvApp: tvApp,
  restartSelf: restartSelf,
  fromHomebrewChannel: fromHomebrewChannel,
  tileHidingOff: TILE_HIDING_OFF,
  assetPath: assetPath,
  assetDirs: ASSET_DIRS,
  luna: luna,
  getMqttStatus: function () { return MQTT_STATUS; },
  version: TVWEB_VERSION
});

if (WEB_ENABLED && !CLI_MODE) routes.loadUI();   // otherwise nothing will serve it

var server = http.createServer(routes.handleRequest);

var webEnabled = WEB_ENABLED;
var mqttEnabled = !!(CONFIG.mqtt && CONFIG.mqtt.enabled && CONFIG.mqtt.host);

/*
 * Refuse to sit there looking healthy while doing nothing. With both the
 * dashboard and the MQTT bridge switched off there is no reason for the
 * process to exist, and a silent no-op is harder to diagnose than an exit.
 */
if (!CLI_MODE && !webEnabled && !mqttEnabled) {
  console.error('nothing to do: web.enabled is false and mqtt is not configured.');
  console.error('enable one of them in config.json.');
  process.exit(1);
}

privacy.checkBootAdBlock(CLI_MODE);

if (!CLI_MODE) servicesModule.startEnforcing();

if (CLI_MODE) {
  // A one-shot run installs a release and exits: no listener, no bridge, no
  // timers, and nothing that would fight the server already running.
} else if (webEnabled) {
  server.listen(CONFIG.port, CONFIG.host, function () {
    console.log('tvweb listening on ' + CONFIG.host + ':' + CONFIG.port +
                '  control=' + CONFIG.allowControl + '  power=' + CONFIG.allowPower +
                '  auth=' + (CONFIG.token ? 'token' : 'none'));
    oled.detectOled(function () {});   // resolve and log panel type up front
    telemetry.detectLogoLight(function () {});
    if (fromHomebrewChannel()) {
      // The Homebrew Channel app is the tile, so the one deploy.sh added goes.
      // Boot is the moment to do it: nothing is open, and it is never removed
      // while open. Once it is gone this finds nothing to do.
      tvApp('retire', function (r) {
        if (r && r.retired) console.log('tv app: old tile removed; the Homebrew Channel app replaces it');
      });
    } else {
      // The home-screen app packages its own loading screen, name and icons at
      // install - the dashboard itself is served fresh - so bring those up to
      // date with this release. A removed app is left removed.
      tvApp('refresh', function (r) {
        if (r && r.refreshed && r.ok) console.log('tv app: refreshed to this release');
      });
    }
  });
} else {
  console.log('web dashboard disabled (web.enabled=false) - mqtt bridge only');
  oled.detectOled(function () {});
}

if (!CLI_MODE) {
  setTimeout(checkHomebrewChannelApp, 60000);
  setInterval(checkHomebrewChannelApp, HBC_CHECK_MS);
}

// ---------------------------------------------------------------- Home Assistant Integration

/*
 * What the dashboard reports about the bridge. The MQTT client is wired up
 * once at startup against the config as it was then, so this is the only way
 * to tell whether the broker settings on screen are the ones actually running.
 */
var MQTT_STATUS = {
  state: 'disabled',   // disabled | connecting | connected | error
  broker: '',
  tls: false,
  detail: '',
  since: Date.now(),
  lastPublish: 0
};

function mqttStatus(state, detail) {
  if (MQTT_STATUS.state !== state) MQTT_STATUS.since = Date.now();
  MQTT_STATUS.state = state;
  MQTT_STATUS.detail = detail || '';
}

var forgetHomeAssistant = function (cb) { cb(); };

function setupHomeAssistant() {
  if (!CONFIG.mqtt || !CONFIG.mqtt.enabled || !CONFIG.mqtt.host) {
    console.log('mqtt: disabled (no host configured)');
    mqttStatus('disabled', CONFIG.mqtt && CONFIG.mqtt.enabled ? 'no broker address set' : '');
    return;
  }

  var pfx = CONFIG.mqtt.topicPrefix || 'lgtv';
  var discPfx = CONFIG.mqtt.discoveryPrefix || 'homeassistant';
  var devId = (CONFIG.device && CONFIG.device.id) || 'lg_b8_tv';
  console.log('mqtt: device id "' + devId + '", topic prefix "' + pfx + '"');
  var statusTopic = pfx + '/status';
  var telemetryTopic = pfx + '/telemetry';
  var stateScreenTopic = pfx + '/state/screen';
  var cmdScreenTopic = pfx + '/command/screen';
  var cmdMuteTopic = pfx + '/command/mute';
  var cmdVolTopic = pfx + '/command/volume';
  var cmdInputTopic = pfx + '/command/input';
  var cmdToastTopic = pfx + '/command/toast';
  var updateTopic = pfx + '/update';

  var devInfo = {
    identifiers: [devId],
    name: (CONFIG.device && CONFIG.device.name) || 'LG webOS TV',
    model: (CONFIG.device && CONFIG.device.model) || 'webOS TV',
    manufacturer: (CONFIG.device && CONFIG.device.manufacturer) || 'LG',
    sw_version: (CONFIG.device && CONFIG.device.sw_version) || 'webOS (tvweb)'
  };

  var useTls = !!CONFIG.mqtt.tls;
  var mqttClient = new MiniMQTT({
    host: CONFIG.mqtt.host,
    port: CONFIG.mqtt.port || (useTls ? 8883 : 1883),
    tls: useTls,
    tlsRejectUnauthorized: CONFIG.mqtt.tlsRejectUnauthorized !== false,
    username: CONFIG.mqtt.username || null,
    password: CONFIG.mqtt.password || null,
    clientId: (CONFIG.mqtt.clientId || (devId + '_tvweb')),
    will: {
      topic: statusTopic,
      payload: 'offline',
      retain: true
    }
  });

  MQTT_STATUS.broker = CONFIG.mqtt.host + ':' + mqttClient.opts.port;
  MQTT_STATUS.tls = useTls;
  mqttStatus('connecting', '');

  var stateMqtt = mqttStateModule.init({
    client: mqttClient,
    prefix: pfx,
    legacyScreenTopic: stateScreenTopic
  });
  stateMqtt.attach(liveState.state);

  // Every retained topic published, so an uninstall can clear them all:
  // discovery, which is what Home Assistant's entities come from, and the
  // state, update and status the broker would otherwise keep for good.
  var retained = {};
  var publishRaw = mqttClient.publish;
  mqttClient.publish = function (topic, message, retain) {
    if (retain) retained[topic] = message !== '';
    return publishRaw.call(mqttClient, topic, message, retain);
  };

  // Entities that send commands, which need the server awake to receive them.
  var CONTROL_TYPES = { 'switch': 1, 'select': 1, 'number': 1, 'button': 1, 'text': 1 };

  function publishDiscovery() {
    ha.clearRetired(function (topic, payload, retain) {
      mqttClient.publish(topic, payload, retain);
    }, discPfx, devId);

    var entities = ha.buildEntities({
      pfx: pfx,
      telemetryTopic: telemetryTopic,
      statusTopic: statusTopic,
      stateScreenTopic: stateScreenTopic,
      cmdScreenTopic: cmdScreenTopic,
      cmdMuteTopic: cmdMuteTopic,
      cmdVolTopic: cmdVolTopic,
      cmdInputTopic: cmdInputTopic,
      cmdToastTopic: cmdToastTopic,
      updateTopic: updateTopic,
      installedApps: telemetry.getInstalledApps(),
      pictureModes: telemetry.getPictureModes(),
      allowPower: CONFIG.allowPower,
      isOled: oled.getIsOled(),
      updatesElsewhere: fromHomebrewChannel()
    });

    entities = ha.filterWithholds(entities, {
      discPfx: discPfx,
      devId: devId,
      publishFn: function (topic, payload, retain) {
        mqttClient.publish(topic, payload, retain);
      },
      capabilities: telemetry.getCapabilities({
        updateCheck: !!(CONFIG.update && CONFIG.update.check),
        isOled: oled.getIsOled(),
        userEntities: (CONFIG.mqtt && CONFIG.mqtt.entities) || {}
      })
    });

    for (var i = 0; i < entities.length; i++) {
      var item = entities[i];
      var conf = item.payload;
      conf.unique_id = devId + '_' + item.id;
      conf.device = devInfo;
      conf.availability_topic = statusTopic;
      conf.availability_template = CONTROL_TYPES[item.type] || ha.AWAKE_ONLY[item.id]
        ? "{{ 'online' if value in ['online', 'off'] else 'offline' }}"
        : "{{ 'offline' if value == 'offline' else 'online' }}";
      conf.payload_available = 'online';
      conf.payload_not_available = 'offline';

      var discTopic = discPfx + '/' + item.type + '/' + devId + '/' + item.id + '/config';
      mqttClient.publish(discTopic, JSON.stringify(conf), true);
    }
    console.log('mqtt: published ' + entities.length + ' Home Assistant discovery entities');
  }

  /*
   * Retained and on its own topic rather than folded into the telemetry
   * payload: Home Assistant's update entity reads the whole message as its
   * state, and this changes once a day at most while telemetry goes out every
   * few seconds.
   */
  function publishUpdate() {
    if (!mqttClient.connected) return;
    var upd = updater.UPDATE;
    mqttClient.publish(updateTopic, JSON.stringify({
      installed_version: TVWEB_VERSION,
      latest_version: upd.latest || null,
      title: 'Server',
      release_url: upd.url || null,
      // Home Assistant caps this at 255 characters and drops the message
      // whole if it is longer.
      release_summary: upd.notes ? upd.notes.slice(0, 255) : null,
      in_progress: !!upd.busy
    }), true);
  }
  updater.setPublishHandler(publishUpdate, publishDiscovery);

  // Empty retained messages remove the entities from Home Assistant, rather
  // than leaving them unavailable, and clear the rest the broker keeps. The
  // clean disconnect stops the broker publishing the "offline" will after.
  // The client has no publish acknowledgement, so this waits a moment for the
  // messages to leave.
  forgetHomeAssistant = function (cb) {
    if (!mqttClient.connected) return cb();
    var topics = Object.keys(retained).filter(function (t) { return retained[t]; });
    topics.forEach(function (t) { mqttClient.publish(t, '', true); });
    console.log('mqtt: cleared ' + topics.length + ' retained topics, removing this TV from Home Assistant');
    setTimeout(function () { mqttClient.disconnect(); setTimeout(cb, 500); }, 1500);
  };

  var lastPicSig = '';
  var lastCapSig = '';

  /*
   * Switched off is a state of the TV, not a loss of it. While the TV is off
   * but still up (Active Standby, for Always-on or panel compensation) the
   * status reads "off"; once it sleeps the broker publishes the will,
   * "asleep". Readings stay available through both and show a switched-off
   * TV. Controls stay available while "off", since the server can still act,
   * and not while "asleep", when a command would reach nothing. While the TV
   * is on, a dropped connection means the server died: the will is "offline".
   */
  var tvOff = false;
  function statusPayload() { return tvOff ? 'off' : 'online'; }
  function setTvOff(off) {
    if (off === tvOff) return;
    tvOff = off;
    console.log('mqtt: TV switched ' + (off ? 'off' : 'on') + ' - status ' + statusPayload());
    if (mqttClient.connected) {
      mqttClient.publish(statusTopic, statusPayload(), true);
      publishTelemetry();
    }
    // After the publishes above: on a B8 the TV can be asleep within 5s.
    mqttClient.setWill(off ? 'asleep' : 'offline');
  }
  liveState.state.onChange(function (ev) {
    if (ev.group === 'power' && ev.key === 'systemOn' && typeof ev.value === 'boolean') setTvOff(!ev.value);
  });

  /*
   * While the TV is off but still up, readings change little and nothing is
   * watching them closely, so they go out once a minute rather than every
   * telemetryIntervalMs. Switching on or off still publishes at once.
   */
  var OFF_INTERVAL_MS = 60000;
  // Kept on disk as well, so a server started while the TV is off, after a
  // deploy or a reboot into standby, still knows what was last on screen.
  var LAST_APP_FILE = '/var/lib/tvweb/last_app.json';
  var lastApp = null, lastAppId = null;
  try {
    var la = JSON.parse(fs.readFileSync(LAST_APP_FILE, 'utf8'));
    lastApp = la.app || null;
    lastAppId = la.app_id || null;
  } catch (e) {}
  var lastPublish = 0;
  function tickTelemetry() {
    if (tvOff && Date.now() - lastPublish < OFF_INTERVAL_MS) return;
    publishTelemetry();
  }

  function publishTelemetry() {
    if (!mqttClient.connected) return;
    lastPublish = Date.now();
    mqttClient.publish(statusTopic, statusPayload(), true);
    telemetry.collectStats(function(s) {
      liveState.reconcile(s);
      s.tvOff = tvOff;
      /*
       * Switched off, the TV has no foreground app, which left Input Source
       * and Launch App reading unknown. They keep the last input and app
       * instead, as the TV itself does when it comes back on. Only the
       * published copy is filled in: the state cache above stays as reported.
       */
      if (!tvOff) {
        if ((s.app && s.app !== lastApp) || (s.app_id && s.app_id !== lastAppId)) {
          lastApp = s.app || lastApp;
          lastAppId = s.app_id || lastAppId;
          try {
            fs.writeFileSync(LAST_APP_FILE, JSON.stringify({ app: lastApp, app_id: lastAppId }), 'utf8');
          } catch (e) {}
        }
      } else {
        if (!s.app && lastApp) s.app = lastApp;
        if (!s.app_id && lastAppId) s.app_id = lastAppId;
      }
      // Retained, so Home Assistant restarting reads the TV as it last was
      // rather than every entity as unknown.
      mqttClient.publish(telemetryTopic, JSON.stringify(s), true);
      MQTT_STATUS.lastPublish = Date.now();
      /*
       * The picture modes a set will accept change with the source's dynamic
       * range, and a select whose options cannot be applied is worse than no
       * select - Home Assistant would offer SDR modes against Dolby Vision
       * content and every one of them would be refused. The options live in
       * the discovery payload, so a changed set means republishing it.
       */
      var sig = ((s.picture && s.picture.modes) || []).map(function (m) {
        return m.value;
      }).join(',');
      if (sig && sig !== lastPicSig) {
        lastPicSig = sig;
        console.log('mqtt: picture modes changed (' + sig + ') - republishing discovery');
        publishDiscovery();
      }
      /*
       * The HDMI diagnostics and the play state only appear once a source has
       * been active, so a set that started on the Home screen looks incapable
       * at first connect. Publishing again each time one of them shows for the
       * first time turns that entity on; nothing is ever unlatched, so this
       * settles rather than flapping.
       */
      /*
       * The network address goes into the device's own record, where Home
       * Assistant shows it and its Wake-on-LAN integration can take it from:
       * the one way to reach the TV once it is asleep. Discovery is sent
       * again the first time it is known.
       */
      if (s.mac && !devInfo.connections) {
        devInfo.connections = [['mac', s.mac]];
        publishDiscovery();
      }
      var cap = telemetry.getCapabilitySignature();
      if (cap !== lastCapSig) {
        lastCapSig = cap;
        console.log('mqtt: set reported (' + cap + ') for the first time - republishing discovery');
        publishDiscovery();
      }
    });
  }

  mqttClient.on('connect', function() {
    mqttStatus('connected', '');
    flushMqttErrorRepeats();
    console.log('mqtt: connected to ' + CONFIG.mqtt.host + ':' + mqttClient.opts.port +
                (useTls ? ' (tls)' : ' (plaintext)'));
    mqttClient.publish(statusTopic, statusPayload(), true);
    // Republish the in-memory state because broker retention is not assumed.
    stateMqtt.publishSnapshot();
    // Do not assert a guessed screen state before the TV reports one.
    // Resolve the panel type first: publishDiscovery filters on it, and on a
    // first connect it would otherwise still be undetermined.
    // The app select's options come from listApps, which on a first connect
    // has not been scanned yet - without this it publishes the fallback list.
    oled.detectOled(function () {
      telemetry.detectLogoLight(function () {
        telemetry.refreshInstalledApps(function () { publishDiscovery(); });
      });
    });
    mqttClient.subscribe(pfx + '/command/#');
    publishTelemetry();
    publishUpdate();
  });

  mqttClient.on('message', function(topic, payload) {
    var prefix = pfx + '/command/';
    if (topic.indexOf(prefix) !== 0) return;
    var action = topic.substring(prefix.length);
    var val = payload ? payload.trim() : '';
    console.log('mqtt: command received: ' + action + ' -> ' + val);

    if (action === 'screen') {
      var turnOff = (val.toUpperCase() === 'OFF');
      doControl(turnOff ? 'screenOff' : 'screenOn', null, function() {});
      return;
    }

    if (action === 'reboot') {
      doControl('reboot', null, function (r) {
        console.log('mqtt: reboot executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'powerOff') {
      doControl('powerOff', null, function (r) {
        console.log('mqtt: powerOff executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'powerOn') {
      doControl('powerOn', null, function (r) {
        console.log('mqtt: powerOn executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'mute') {
      doControl('mute', val.toUpperCase() === 'ON', function (r) {
        console.log('mqtt: mute set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'volume') {
      doControl('volume', num(val, 10), function (r) {
        console.log('mqtt: volume set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'input') {
      doControl('input', val.toLowerCase().replace(/\s+/g, ''), function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'toast') {
      doControl('toast', val, function() {});
      return;
    }

    if (action === 'update') {
      // Home Assistant's update entity sends `install`. Anything else on this
      // topic is read as a request to look rather than to install, so an
      // automation can refresh the entity without upgrading the TV.
      if (val.toLowerCase() !== 'install') {
        doControl('updateCheck', null, function () {});
        return;
      }
      doControl('update', null, function (r) {
        console.log('mqtt: update requested, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'refresher') {
      var sch = (val.toLowerCase() === 'schedule' || val.toLowerCase() === 'on');
      doControl(sch ? 'refresherSchedule' : 'refresherCancel', null, function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    doControl(action, val, function() {
      setTimeout(publishTelemetry, 400);
    });
  });

  /*
   * A connection attempt fails every 5 seconds while the broker is
   * unreachable, and each one arrives here with the same message. Logging all
   * of them wrote ~17,000 identical lines a day to flash for as long as the
   * outage lasted. Repeats are counted instead, and the total is reported once
   * the message changes or the client connects - the fact worth having is how
   * long it went on, not each attempt.
   */
  var lastMqttError = null;
  var mqttErrorRepeats = 0;

  function flushMqttErrorRepeats() {
    if (mqttErrorRepeats) {
      console.error('mqtt error: last message repeated ' + mqttErrorRepeats + ' more time' +
                    (mqttErrorRepeats === 1 ? '' : 's'));
      mqttErrorRepeats = 0;
    }
    lastMqttError = null;
  }

  mqttClient.on('error', function(err) {
    mqttStatus('error', err.message);
    if (err.message === lastMqttError) { mqttErrorRepeats++; return; }
    flushMqttErrorRepeats();
    lastMqttError = err.message;
    console.error('mqtt error:', err.message);
  });

  /* A socket error destroys the socket, so 'close' follows it. The error text
     is the part worth reporting, so it stands until the next connect. */
  mqttClient.on('close', function() {
    if (MQTT_STATUS.state !== 'error') mqttStatus('connecting', msg('srv.mqtt.dropped', 'connection dropped, retrying'));
  });

  process.on('SIGTERM', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });
  process.on('SIGINT', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });

  var intervalMs = CONFIG.mqtt.telemetryIntervalMs || 10000;
  setInterval(tickTelemetry, intervalMs);

  liveState.start();
  notificationState.start();
  mqttClient.connect();
}

/*
 * Liveness marker for the watchdog in tvwebctl.
 *
 * A wedged server keeps its port open and its process alive, so "is it
 * listening" proves nothing: on 2026-09-09 the loop froze inside libuv's
 * spawn path - a forked child deadlocked on a futex before reaching exec, so
 * the parent blocked forever reading the 4-byte exec-error pipe - and the
 * dashboard, MQTT and everything else stopped while the process looked fine.
 * A timer that stops firing is the signal that catches it. /var/run is tmpfs,
 * so this costs no flash writes.
 */
var BEAT_FILE = '/var/run/tvweb.beat';

/* Seconds, not milliseconds: the watchdog is busybox ash, whose arithmetic is
   32-bit, and a 13-digit millisecond stamp overflows it into nonsense. */
function heartbeat() {
  fs.writeFile(BEAT_FILE, String(Math.floor(Date.now() / 1000)), function () {});
}

if (!CLI_MODE) {
  heartbeat();
  setInterval(heartbeat, 20000);

  screensavers.restageScreensaver();

  telemetry.detectDeviceInfo(function() {
    setupHomeAssistant();
  });

  // Not at startup: a reboot brings the whole house back at once, and nothing
  // about this is urgent.
  updater.scheduleUpdateChecks(120000);
}

/*
 * The one-shot modes. Last in the file so every function they use is defined,
 * and so nothing above has started a server this process is about to end.
 *
 * Exit 3 from --update means there was nothing newer, which tvwebctl reads as
 * "no restart needed" rather than as a failure.
 */
if (CLI_MODE === 'check') {
  updater.checkForUpdate(true, function (err, summary) {
    if (err) { console.error(err.message); process.exit(1); }
    console.log('installed v' + TVWEB_VERSION + ', latest v' + summary.latest +
                (summary.available ? ' - update available' : ' - up to date'));
    process.exit(0);
  });
} else if (CLI_MODE === 'update') {
  updater.installUpdate(function (r) {
    if (!r.ok) { console.error(r.error); process.exit(1); }
    if (!r.updated) { console.log(r.note + ' (v' + r.installed + ')'); process.exit(3); }
    console.log('installed v' + r.latest + ' over v' + r.installed + ', ' + r.files + ' files');
    process.exit(0);
  });
} else if (CLI_MODE === 'rollback') {
  updater.rollbackUpdate(function (r) {
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.log('restored v' + r.restored + ', ' + r.files + ' files');
    process.exit(0);
  });
}
