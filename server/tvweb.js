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
var stateModule = require('./lib/state');
var mqttStateModule = require('./lib/mqtt-state');
var notifications = require('./lib/notifications');
var lunaTransport = require('./lib/luna');
var luna = lunaTransport.call;
var zeroBuffer = MiniMQTT.zeroBuffer;

/*
 * Bump on release, and tag the release to match: the dashboard turns this into
 * a link to /releases/tag/v<version>, so a value with no tag behind it gives a
 * 404 rather than a wrong page.
 */
var TVWEB_VERSION = '0.43.1';

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
  'active':          ['On',          true,  true],
  'on':              ['On',          true,  true],
  'screenoff':       ['Screen off',  true,  false],
  'screensaver':     ['Screen Saver',true,  true],
  'activestandby':   ['Standby',     false, false],
  'standby':         ['Standby',     false, false],
  'suspend':         ['Standby',     false, false],
  'preparesuspend':  ['Standby',     false, false],
  'requestpoweroff': ['Off',         false, false],
  'poweroff':        ['Off',         false, false],
  'off':             ['Off',         false, false],
  'prepared':        ['Starting up', true,  false],
  'processing':      ['Standby',     false, false]
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

/*
 * Measured on a B8 against the built-in player, watching playStateNow move:
 * KEY_PAUSE pauses, KEY_PLAY resumes, and KEY_PLAYPAUSE, KEY_PAUSECD and
 * KEY_PLAYCD do nothing at all. Pause was previously sent as KEY_PAUSECD,
 * which is why it never worked.
 *
 * Over CEC to an external box, KEY_PLAY behaves as a toggle instead.
 */
var RCU_KEY_CODES = {
  play: 207,
  pause: 119,
  stop: 128,
  fastForward: 208,
  fastforward: 208,
  rewind: 168
};

/*
 * No key toggles the built-in player, so this asks what it is doing and sends
 * the other one. An external input reports "playing" whatever the box on the
 * end is doing, and KEY_PLAY is a toggle over CEC, so that path just sends it.
 */
function sendPlayPause(cb) {
  luna('com.webos.service.acb/getForegroundAppInfo', {}, function (acb) {
    var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
    var external = !pipe || pipe.playerType === 'external input';
    var paused = !!(pipe && String(pipe.playStateNow) === 'paused');
    sendMediaKey(external || paused ? 'play' : 'pause', cb);
  });
}

function sendMediaKey(cmd, cb) {
  if (cmd === 'playPause' || cmd === 'playpause') return sendPlayPause(cb);
  var code = RCU_KEY_CODES[cmd];
  if (!code) {
    if (cb) cb(false);
    return;
  }
  injectKey(code, cb);
}

// KEY_BACK. Used to dismiss a screen saver, which consumes the first key it
// gets, so nothing behind it sees this.
var KEY_BACK = 158;

var rcuDevicePath = null;
function getRcuDevicePath() {
  if (rcuDevicePath) return rcuDevicePath;
  try {
    var devices = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    var m = /Name="LGE RCU"[\s\S]*?Handlers=[^\n]*?(event\d+)/.exec(devices);
    if (!m) m = /Name="Smart Remote RCU Input"[\s\S]*?Handlers=[^\n]*?(event\d+)/.exec(devices);
    if (m && m[1]) {
      rcuDevicePath = '/dev/input/' + m[1];
      return rcuDevicePath;
    }
  } catch (e) {}
  rcuDevicePath = '/dev/input/event1';
  return rcuDevicePath;
}

function injectKey(code, cb, delayMs) {
  var fd = null;
  var dev = getRcuDevicePath();
  try {
    fd = fs.openSync(dev, 'w');
  } catch (e) {
    if (dev !== '/dev/input/event1') {
      try { fd = fs.openSync('/dev/input/event1', 'w'); } catch (e2) {}
    }
    if (!fd) {
      if (cb) cb(false);
      return;
    }
  }
  var delay = (typeof delayMs === 'number') ? delayMs : 50;
  function makeEv(type, c, val) {
    var b = zeroBuffer(16);
    b.writeUInt16LE(type, 8);
    b.writeUInt16LE(c, 10);
    b.writeInt32LE(val, 12);
    return b;
  }
  try {
    fs.writeSync(fd, makeEv(1, code, 1), 0, 16, null);
    fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
    setTimeout(function () {
      try {
        fs.writeSync(fd, makeEv(1, code, 0), 0, 16, null);
        fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
        fs.closeSync(fd);
        if (cb) cb(true);
      } catch (e2) {
        if (cb) cb(false);
      }
    }, delay);
  } catch (e) {
    try { fs.closeSync(fd); } catch (e3) {}
    if (cb) cb(false);
  }
}

privacy.init({ luna: luna, lunaCached: lunaCached, config: CONFIG });
oled.init({ luna: luna, config: CONFIG });
appsModule.init({ luna: luna, config: CONFIG });
servicesModule.init({ stateDir: __dirname });
screensavers.init({
  luna: luna,
  assetPath: assetPath,
  config: CONFIG,
  injectKey: injectKey,
  KEY_BACK: KEY_BACK,
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
  isScreenSaver: isScreenSaver
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

/*
 * Remote navigation. Sent through the network input service rather than written
 * to /dev/input: it is a service call, and the TV accepts it whatever is in the
 * foreground.
 *
 * Arrows and enter are the standard evdev codes. Back is LG's own - 412, the
 * IR_KEY_BACK in /usr/share/X11/xkb/keycodes/lg less the 8 that xkb adds - and
 * measured on a C2 it is the one that acts; evdev's 158 is taken as a dismissal
 * rather than a step back. The service refuses anything above about 512, which
 * rules out the rest of LG's table. Home is launched as com.webos.app.home on
 * webOS 6+ and falls back to injectKey(125) for the webOS 3-5 ribbon.
 */
var RCU_KEYS = {
  up: 103,
  down: 108,
  left: 105,
  right: 106,
  ok: 28,
  back: 412
};
var SLEEP_TIMER_VALUES = ['off', '10', '30', '60', '90', '120'];
var ENERGY_SAVING_VALUES = ['auto', 'off', 'min', 'med', 'max', 'screen_off'];

// What the dashboard reports
// What the settings service accepts for logoLuminanceAdjust, per
// getSystemSettingValues on a B8. "strong" is the strongest, not an on/off.
var LOGO_DIMMING_VALUES = ['off', 'light', 'strong'];

function doControl(action, value, cb) {
  if (!CONFIG.allowControl) return cb({ ok: false, error: 'controls disabled in config' });

  var origCb = cb;
  cb = function (r) {
    if (r && r.ok) { telemetry.clearCache(); clearLunaCache(); }
    origCb(r);
  };

  switch (action) {
    case 'volume':
      return luna('com.webos.audio/setVolume',
                  { volume: Math.max(0, Math.min(100, num(value, 10))) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'volumeStep':
      var step = num(value, 1);
      if (step === 1) {
        return luna('com.webos.audio/volumeUp', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      if (step === -1) {
        return luna('com.webos.audio/volumeDown', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      return luna('com.webos.audio/getVolume', {}, function (cur) {
        var curVol = (cur && typeof cur.volume === 'number') ? cur.volume : 10;
        var target = Math.max(0, Math.min(100, curVol + step));
        luna('com.webos.audio/setVolume', { volume: target }, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'mute':
      var shouldMute = (value === 'true' || value === true || value === 'ON' || value === '1' || value === 1);
      return luna('com.webos.audio/setMuted',
                  { muted: shouldMute },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOff':   // OLED: blank the panel, keep audio playing
      return luna('com.webos.service.tvpower/power/turnOffScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOn':
      return luna('com.webos.service.tvpower/power/turnOnScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'input':
      if (!INPUTS[value]) return cb({ ok: false, error: 'unknown input' });
      return luna('com.webos.applicationManager/launch',
                  { id: 'com.webos.app.' + value },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'launch_app':
    case 'launchApp':
      var appId = String(value || '').trim();
      if (!appId) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/launch', { id: appId }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'launch_url':
    case 'launchUrl':
      /* The browser has no "open this" call of its own: the address rides in
         as a launch parameter. Only http(s) is accepted - anything else, a
         file: path or a javascript: line, would be handed to the browser as
         written, and the dashboard is reachable by everyone on the network. */
      var target = String(value || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(target)) {
        return cb({ ok: false, error: 'url must start with http:// or https://' });
      }
      return luna('com.webos.applicationManager/launch',
                  { id: BROWSER_APP, params: { target: target } },
                  function (r) {
                    cb({ ok: !!(r && r.returnValue), error: r && r.errorText });
                  });

    case 'close_app':
    case 'closeApp':
      var appIdToClose = String(value || '').trim();
      if (!appIdToClose) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/closeByAppId', { id: appIdToClose }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'picture_mode':
    case 'pictureMode':
      var pMode = String(value || '').trim();
      if (!pMode) return cb({ ok: false, error: 'missing picture mode' });
      return luna('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode'] }, function (cur) {
        var pPayload = { category: 'picture', settings: { pictureMode: pMode } };
        if (cur && cur.dimension) pPayload.dimension = cur.dimension;
        luna('com.webos.service.settings/setSystemSettings', pPayload, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'energySaving':
      var energySaving = String(value || '').trim().toLowerCase();
      if (ENERGY_SAVING_VALUES.indexOf(energySaving) === -1) {
        return cb({ ok: false, error: 'energy saving must be one of ' + ENERGY_SAVING_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings', {
        category: 'picture',
        settings: { energySaving: energySaving, energySavingModified: 'true' }
      }, function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'sound_output':
    case 'soundOutput':
      var sOut = String(value || '').trim();
      if (!sOut) return cb({ ok: false, error: 'missing sound output' });
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'sound', settings: { soundOutput: sOut } },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'playback':
    case 'media':
      return sendMediaKey(value, function (ok) {
        cb({ ok: ok });
      });

    /*
     * Two tiers: "ads" blocks the ad and telemetry hosts, "full" takes LG's
     * store and update endpoints with them. Callers that predate the choice
     * pass a boolean and still mean off/full.
     */
    case 'adblock':
    case 'setAdBlock':
    case 'toggleAdBlock':
      var abMode = String(value == null ? '' : value).toLowerCase();
      if (action === 'toggleAdBlock' || abMode === 'toggle') {
        abMode = privacy.isAdBlockActive() ? 'off' : 'full';
      } else if (abMode !== 'off' && abMode !== 'ads' && abMode !== 'full') {
        abMode = (value === true || abMode === 'on' || abMode === 'true' || abMode === '1')
          ? 'full' : 'off';
      }
      return privacy.setAdBlock(abMode, function (res) { cb(res); });

    case 'resetAdId':
      return privacy.resetAdId(cb);

    case 'acr':
      var acrOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings', {
        category: 'option',
        settings: { livePlus: acrOn ? 'on' : 'off' }
      }, function (r) {
        privacy.setConsent('acrAllowed', acrOn, function () {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'consent':
      var ckey = (value && value.key) ? String(value.key) : '';
      var cOn = !!(value && (value.enabled === true || value.enabled === 'true'));
      return privacy.setConsent(ckey, cOn, cb);

    case 'clearAdCookies':
      return privacy.clearAdCookies(cb);

    /*
     * Sleep timer. Accepted values are off, 10, 30, 60, 90, 120 - 15 is
     * rejected by the settings service despite being an obvious guess.
     */
    case 'sleepTimer':
      var st = String(value == null ? 'off' : value).trim();
      if (SLEEP_TIMER_VALUES.indexOf(st) === -1) {
        return cb({ ok: false, error: 'sleep timer must be one of ' + SLEEP_TIMER_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'time', settings: { sleepTimer: st } },
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    // Front panel LEDs. Both live in the "option" category.
    /*
     * Both live in the picture category and are OLED panel protections, not
     * picture settings: screenShift takes on/off, logoLuminanceAdjust takes
     * off/light/strong. The settings service publishes the accepted values
     * through getSystemSettingValues, and a rejected one returns false rather
     * than erroring, so an unsupported value simply does not take.
     */
    case 'screenShift':
      var shiftOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { screenShift: shiftOn ? 'on' : 'off' } },
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    case 'logoDimming':
      var logoVal = String(value || '').trim().toLowerCase();
      if (LOGO_DIMMING_VALUES.indexOf(logoVal) === -1) {
        return cb({ ok: false, error: 'logo dimming takes ' + LOGO_DIMMING_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { logoLuminanceAdjust: logoVal } },
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    case 'standbyLight':
    case 'logoLight':
      var lightKey = (action === 'standbyLight') ? 'standByLight' : 'logoLight';
      var lightOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var lightPayload = { category: 'option', settings: {} };
      lightPayload.settings[lightKey] = lightOn ? 'on' : 'off';
      return luna('com.webos.service.settings/setSystemSettings', lightPayload,
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    case 'quickBoot':
      var qbOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'option', settings: { quickStartMode: qbOn ? 'on' : 'off' } },
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    case 'serviceMenuLock':
      return oled.setServiceMenuLock(!!(value && value.locked), cb);

    case 'serviceMenuOpen':
      return oled.openServiceMenu(String((value && value.menu) || 'ezAdjust'), cb);

    case 'oledProtection':
      var prot = (value && typeof value === 'object') ? value : {};
      return oled.setOledProtection(String(prot.key || ''), !!prot.enabled, cb);

    case 'tvAppInstall':
      return tvApp('install', cb);

    case 'tvAppRemove':
      return tvApp('remove', cb);

    case 'rcu':
      var rcuName = String(value || '').trim().toLowerCase();
      if (rcuName === 'home') {
        // webOS 6+ (2021+) uses com.webos.app.home as a standalone app.
        // webOS 3-5 (2016-2020) does not have com.webos.app.home (the launcher
        // is a system UI component); KEY_LEFTMETA (125) with a 100ms press/release
        // delay triggers the native home ribbon across webOS versions.
        return luna('com.webos.applicationManager/launch', { id: 'com.webos.app.home' },
                    function (r) {
                      if (r && r.returnValue) {
                        telemetry.clearCache();
                        return cb({ ok: true });
                      }
                      injectKey(125, function (ok) {
                        telemetry.clearCache();
                        cb({ ok: ok });
                      }, 100);
                    });
      }
      if (!RCU_KEYS.hasOwnProperty(rcuName)) {
        return cb({ ok: false, error: 'unknown key: ' + rcuName });
      }
      return luna('com.webos.service.networkinput/test/sendKeyCode',
                  { keyCode: RCU_KEYS[rcuName] },
                  function (r) { telemetry.clearCache(); cb({ ok: !!(r && r.returnValue) }); });

    case 'screensaverMode':
      /*
       * The mode and how brightly to draw it are staged together: both are
       * written into the same file, so setting one without the other would
       * quietly reset it.
       */
      var ssMode = value, ssLevel = screensavers.screensaverLevel();
      if (value && typeof value === 'object') {
        ssMode = value.mode;
        if (value.level) ssLevel = value.level;
      }
      return screensavers.setScreensaver(String(ssMode || '').trim(), ssLevel, function (r) {
        telemetry.clearCache();
        cb(r);
      });

    case 'screensaver':
      return screensavers.trigger(function (r) {
        telemetry.clearCache();
        cb(r);
      });

    case 'toast':
      /* Both the payload's sourceId and luna-send's -a have to name an app the
         bus already knows; "tvweb" is rejected as an Unknown Source. */
      return luna('com.webos.notification/createToast',
                  { sourceId: TOAST_SOURCE, message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue), error: r && r.errorText }); },
                  TOAST_SOURCE);

    case 'tileHiding':
      return appsModule.setTileHidingEnabled(!!value, function (r) {
        telemetry.clearCache();
        cb(r);
      });

    case 'powerOff':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      return luna('com.webos.service.tvpower/power/powerOff', { reason: 'remoteKey' },
                  function (r) {
                    if (r && r.returnValue) return cb({ ok: true });
                    luna('com.webos.service.tvpower/power/powerOff', { reason: 'localKey' }, function (r2) {
                      cb({ ok: !!(r2 && r2.returnValue), error: (r2 && r2.errorText) || (r && r.errorText) });
                    });
                  });

    /*
     * Reboot deliberately does NOT go through tvpower.
     *
     * On webOS 4.4.3, luna://com.webos.service.tvpower/power/reboot accepts
     * the request and reports success, but the kernel never restarts: the set
     * drops off the network for about a minute and comes back with its uptime
     * still climbing. Measured on an OLED65B8SLC - 12810s before the call,
     * 12871s after. It behaves like a standby transition, not a reboot, so the
     * button was reporting success while doing something else entirely.
     *
     * /sbin/reboot performs a real orderly restart (verified: uptime reset to
     * 60s, services and the webosbrew boot hook all came back cleanly).
     *
     * Reply first - this process is about to go down with the system.
     */
    case 'reboot':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      cb({ ok: true, note: 'rebooting' });
      return setTimeout(function () {
        execFile('/bin/sh', ['-c', 'sync; /sbin/reboot'], function () {});
      }, 400);

    case 'refresherSchedule':
      return oled.requestClearPanelNoise('schedule', cb);

    case 'refresherCancel':
      return oled.requestClearPanelNoise('cancel_schedule', cb);

    case 'updateCheck':
      // 'open' is the dashboard's Server tab being shown. Its result is kept for
      // two minutes, so switching between tabs does not reach GitHub each time.
      return updater.checkForUpdate(value === 'open' ? 120000 : true, function (e, summary) {
        if (e) return cb({ ok: false, error: e.message });
        cb(summary);
      });

    case 'update':
      return updater.installUpdate(function (r) {
        if (r.ok && r.updated) {
          setTimeout(function () {
            if (!restartSelf()) console.error('update: no tvwebctl found - restart manually to apply');
          }, 600);
        }
        cb(r);
      });

    case 'updateAutoCheck':
      return updater.setAutoCheck(value === true || value === 'on' || value === 'true', cb);

    case 'updateRollback':
      return updater.rollbackUpdate(function (r) {
        if (r.ok) setTimeout(function () { restartSelf(); }, 600);
        cb(r);
      });

    default:
      return cb({ ok: false, error: 'unknown action' });
  }
}



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

/*
 * The address a phone on the same network can reach this server at. The TV app
 * only ever sees localhost, so it cannot work this out for itself, and a QR
 * code of "localhost" would be useless to the person holding the phone.
 */
function lanOrigin() {
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
  if (!best) return null;
  return 'http://' + best + ':' + CONFIG.port;
}

/*
 * The app that puts this dashboard on the TV's own screen. Installing it is a
 * packaging job for shell, so it lives in a script beside the app's files and
 * its result is read back here. An absent script - an older deploy, or a TV
 * that will not take an unsigned app - reports unsupported, and the dashboard
 * hides the control rather than offering something that cannot work.
 */
function tvApp(action, cb) {
  var script = assetPath('dashboard-app/install-app.sh');
  if (!script) return cb({ ok: true, supported: false, installed: false });
  execFile('/bin/sh', [script, action], { timeout: 90000 }, function (err, stdout) {
    var out = String(stdout || '').trim();
    var last = out.split('\n').pop();
    try { return cb(JSON.parse(last)); }
    catch (e) {
      // install prints a sentence rather than JSON, so read its wording.
      if (action === 'install') return cb({ ok: /added to the home screen/.test(out) });
      return cb({ ok: !err, error: err ? err.message : 'unreadable result' });
    }
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
    '<title>LG webOS TV &middot; dashboard assets missing</title>',
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
    ASSET_DIRS.map(function (d) {
      return '<li><code>' + d.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></li>';
    }).join(''),
    '</ul>',
    '<p>Deploying again restores it: <code>./server/deploy.sh &lt;tv-ip&gt;</code>.</p>',
    '<p class="dim">tvweb ' + TVWEB_VERSION + '</p>',
    '</body></html>'
  ].join('\n');
}

var UI_HTML = null;
var UI_HTML_GZ = null;
var ASSET_CACHE = {};

(function loadUI() {
  if (!WEB_ENABLED || CLI_MODE) return;   // nothing will serve it
  var f = assetPath('ui.html');
  if (!f) {
    console.error('assets: ui.html not found in ' + ASSET_DIRS.join(', ') +
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
})();

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

// ---------------------------------------------------------------- server
function send(res, code, body, type) {
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

/*
 * Settings the dashboard is allowed to write. Everything else in config.json
 * (port, host, allowControl, allowPower, token) stays file-only: those decide
 * who may reach this server at all, and a UI that can widen its own exposure
 * defeats the point of setting them.
 */
function readConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('warning: could not re-read ' + CONFIG_FILE + ': ' + e.message);
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

var HA_CATEGORIES = ha.HA_CATEGORIES;
var HA_ENTITIES = ha.HA_ENTITIES;
var ENTITY_CATEGORIES = ha.ENTITY_CATEGORIES;
var entityCategory = ha.entityCategory;

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
    var tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.chmodSync(tmp, parseInt('600', 8));
    fs.renameSync(tmp, CONFIG_FILE);   // atomic: never leave a half-written config
  } catch (err) {
    return cb(err);
  }
  cb(null);
}

updater.init({ config: CONFIG, version: TVWEB_VERSION, installDir: __dirname, writeSettings: writeSettings });

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

function authed(q, req) {
  if (!CONFIG.token) return true;
  if (q.k === CONFIG.token) return true;
  // The on-TV dashboard app fetches from localhost and has no way to carry a
  // token (there is no login prompt on a TV remote).  A process on the TV
  // already has root, so the token adds nothing for local requests.
  if (req) {
    var ra = req.connection.remoteAddress || '';
    if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return true;
  }
  return false;
}

function readJsonBody(req, res, cb) {
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

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname;

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
    var cacheHdr = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
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
    return send(res, 200, JSON.stringify({
      ok: true, allowControl: CONFIG.allowControl, allowPower: CONFIG.allowPower,
      origin: lanOrigin()
    }));
  }

  if (pathname === '/api/screensaver') {
    return send(res, 200, JSON.stringify(screensavers.screensaverList()));
  }

  if (pathname === '/api/hdmi') {
    return telemetry.hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/servicemenu') {
    return oled.serviceMenuState(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/tvapp') {
    return tvApp('status', function (r) {
      if (r && r.ok) r.writable = CONFIG.allowControl;
      send(res, 200, JSON.stringify(r));
    });
  }

  if (pathname === '/api/oledcare') {
    return oled.readOledProtections(function (live) {
      telemetry.collectStats(function (st) {
        var oledData = st.oled || {};
        send(res, 200, JSON.stringify({
          ok: true,
          isOled: !!st.oled,
          // Whether this set has the service the service menu goes through.
          serviceControls: oled.oledProtControllable(),
          writable: CONFIG.allowControl,
          /*
           * null where the set says nothing. Without the service, all there is
           * are the marker files, and a set that writes none of them - a B8
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
    return telemetry.collectCpuProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    return telemetry.collectProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/privacy') {
    return privacy.collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (pathname === '/api/apps' && req.method === 'GET') {
    return appsModule.getApps(function (d) {
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

  if (pathname === '/api/apps/uninstall' && req.method === 'POST') {
    return readJsonBody(req, res, function (body) {
      appsModule.uninstallApp(body.id, function (r) {
        send(res, r && r.ok ? 200 : 400, JSON.stringify(r));
      });
    });
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
    return telemetry.collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  /* Reports what is known, and never checks on its own: the dashboard polls
     this, and a poll that reached GitHub would be a request per viewer. */
  if (pathname === '/api/update') {
    return send(res, 200, JSON.stringify(updater.updateSummary()));
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    var mc = CONFIG.mqtt || {};
    return send(res, 200, JSON.stringify({
      ok: true,
      writable: CONFIG.allowControl,
      configFile: CONFIG_FILE,
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
        id: (CONFIG.device && CONFIG.device.id) || '',
        name: (CONFIG.device && CONFIG.device.name) || ''
      },
      /* Ages rather than timestamps: the TV's clock is often minutes off the
         browser's, and a negative "last publish" reads as a fault. */
      status: {
        state: MQTT_STATUS.state,
        broker: MQTT_STATUS.broker,
        tls: MQTT_STATUS.tls,
        detail: MQTT_STATUS.detail,
        forMs: Date.now() - MQTT_STATUS.since,
        lastPublishMs: MQTT_STATUS.lastPublish ? Date.now() - MQTT_STATUS.lastPublish : null
      }
    }));
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!authed(u.query, req)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
    if (!CONFIG.allowControl) {
      return send(res, 403, JSON.stringify({ ok: false, error: 'controls disabled in config' }));
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
          return send(res, 500, JSON.stringify({ ok: false, error: 'could not write ' + CONFIG_FILE + ': ' + err.message }));
        }
        console.log('settings: saved to ' + CONFIG_FILE + ', restarting to apply');
        /*
         * Answer before restarting: the restart kills this process, and the
         * browser needs the result to know the save itself succeeded.
         */
        send(res, 200, JSON.stringify({ ok: true, restarting: true }));
        setTimeout(function () {
          if (!restartSelf()) console.error('settings: no tvwebctl found - restart manually to apply');
        }, 250);
      });
    });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
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
});

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
  });
} else {
  console.log('web dashboard disabled (web.enabled=false) - mqtt bridge only');
  oled.detectOled(function () {});
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
      isOled: oled.getIsOled()
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

  var lastPicSig = '';
  var lastCapSig = '';

  function publishTelemetry() {
    if (!mqttClient.connected) return;
    mqttClient.publish(statusTopic, 'online', true);
    telemetry.collectStats(function(s) {
      liveState.reconcile(s);
      mqttClient.publish(telemetryTopic, JSON.stringify(s), false);
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
    mqttClient.publish(statusTopic, 'online', true);
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
    if (MQTT_STATUS.state !== 'error') mqttStatus('connecting', 'connection dropped, retrying');
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
  setInterval(publishTelemetry, intervalMs);

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
