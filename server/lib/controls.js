// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var execFile = require('child_process').execFile;
var msg = require('./say').msg;
var zeroBuffer = require('./mqtt').zeroBuffer;

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

// KEY_BACK. Used to dismiss a screen saver, which consumes the first key it
// gets, so nothing behind it sees this.
var KEY_BACK = 158;

var SLEEP_TIMER_VALUES = ['off', '10', '30', '60', '90', '120'];
var ENERGY_SAVING_VALUES = ['auto', 'off', 'min', 'med', 'max', 'screen_off'];

// What the settings service accepts for logoLuminanceAdjust, per
// getSystemSettingValues on a B8. "strong" is the strongest, not an on/off.
var LOGO_DIMMING_VALUES = ['off', 'light', 'strong'];

var luna = null;
var clearLunaCache = function () {};
var config = {};
var telemetry = null;
var oled = null;
var privacy = null;
var servicesModule = null;
var screensavers = null;
var appsModule = null;
var lgSettings = null;
var updater = null;
var tvAppFn = null;
var restartSelfFn = null;
var updateSummaryFn = null;
var fromHbcFn = null;
var inputMap = null;
var browserAppId = null;
var toastSourceId = null;
var tileHidingOffMsg = null;

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

function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

// What tvweb.js passes to init(). Called as given: a module left unwired fails
// at the call, where it shows, rather than answering as though it had worked.
function isFromHbc() { return fromHbcFn(); }
function getUpdateSummary() { return updateSummaryFn(); }
function doRestartSelf() { return restartSelfFn(); }
function doTvApp(action, cb) { return tvAppFn(action, cb); }

function doControl(action, value, cb) {
  cb = cb || function () {};
  if (!config.allowControl) return cb({ ok: false, error: msg('srv.controlsOff', 'controls disabled in config') });

  var origCb = cb;
  cb = function (r) {
    if (r && r.ok) {
      telemetry.clearCache();
      clearLunaCache();
    }
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
      if (!inputMap[value]) return cb({ ok: false, error: 'unknown input' });
      return luna('com.webos.applicationManager/launch',
                  { id: 'com.webos.app.' + value },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'launch_app':
    case 'launchApp':
      var appId = String(value || '').trim();
      if (!appId) return cb({ ok: false, error: 'missing app id' });
      // Home Assistant sends ids, but a name is accepted too, matched loosely.
      var apps = telemetry.getInstalledApps() || [];
      var isId = apps.some(function (x) { return x.id === appId; });
      if (!isId) {
        var want = appId.toLowerCase();
        for (var ai = 0; ai < apps.length; ai++) {
          if (String(apps[ai].title || '').toLowerCase() === want) { appId = apps[ai].id; break; }
        }
      }
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
                  { id: browserAppId, params: { target: target } },
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
      /* Home Assistant sends one id per name, and some names cover two ids
         that differ between firmware; the other is tried if the first is
         refused. */
      var sAlias = { optical: 'external_optical', external_optical: 'optical',
                     tv_speaker: 'internal', internal: 'tv_speaker' }[sOut];
      var setOut = function (id, next) {
        luna('com.webos.service.settings/setSystemSettings',
             { category: 'sound', settings: { soundOutput: id } }, function (r) { next(!!(r && r.returnValue)); });
      };
      return setOut(sOut, function (ok) {
        if (ok || !sAlias) return cb({ ok: ok });
        setOut(sAlias, function (ok2) { cb({ ok: ok2 }); });
      });

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

    /*
     * Everything the Privacy tab's summary counts as still on, switched off
     * one at a time through the actions above. Read fresh, so it acts on the
     * TV as it is now rather than on what a dashboard last saw. The ad block
     * goes first: it takes effect at once and covers the rest while they change.
     */
    case 'privacyAllOff':
      privacy.clearCache();
      return privacy.collectPrivacy(function (p) {
        var todo = [];
        p.simple.areas.forEach(function (a) { todo = todo.concat(a.items); });
        todo.sort(function (x, y) { return (y.action === 'setAdBlock' ? 1 : 0) - (x.action === 'setAdBlock' ? 1 : 0); });
        var failed = [];
        (function next(i) {
          if (i >= todo.length) {
            privacy.clearCache();
            return cb({ ok: !failed.length, done: todo.length - failed.length, failed: failed,
                        error: failed.length ? 'could not switch off: ' + failed.join(', ') : undefined });
          }
          var t = todo[i];
          var after = function (r) { if (!r || !r.ok) failed.push(t.label); next(i + 1); };
          if (t.service) return servicesModule.toggleService(t.service, true, after);
          doControl(t.action, t.value, after);
        })(0);
      });

    case 'resetAdId':
      return privacy.resetAdId(cb);

    case 'limitAdTracking':
      return privacy.setLimitTracking(value === true || value === 'on' || value === 'true', cb);

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
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

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
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'logoDimming':
      var logoVal = String(value || '').trim().toLowerCase();
      if (LOGO_DIMMING_VALUES.indexOf(logoVal) === -1) {
        return cb({ ok: false, error: 'logo dimming takes ' + LOGO_DIMMING_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { logoLuminanceAdjust: logoVal } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'standbyLight':
    case 'logoLight':
      var lightKey = (action === 'standbyLight') ? 'standByLight' : 'logoLight';
      var lightOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var lightPayload = { category: 'option', settings: {} };
      lightPayload.settings[lightKey] = lightOn ? 'on' : 'off';
      return luna('com.webos.service.settings/setSystemSettings', lightPayload,
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'quickBoot':
      var qbOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'option', settings: { quickStartMode: qbOn ? 'on' : 'off' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    /*
     * The same setting as LG's "Mobile TV On" / "Turn on via Wi-Fi" menu.
     * webos-connman-adapter subscribes to it and passes it to connman, which
     * keeps it as WOLWOWLMode in /var/lib/connman/settings for the power
     * daemon to read at standby, so writing the setting is all LG's menu does.
     */
    /*
     * LG's "LG Logo Display": the logo shown as the TV switches on and off.
     * tvpowerd subscribes to the key, so writing it is all LG's menu does.
     * Only on firmware that has it: a C2 on webOS 9.2 does, a B8 on 4.4 does not.
     */
    // LG's universal control device detection (other/ueiEnable); see telemetry.
    case 'deviceDetection':
      var ddOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'other', settings: { ueiEnable: ddOn ? 'on' : 'off' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    /*
     * LG's Always-on (general/alwaysOn), not its Always Ready, which is
     * lifeOnScreenMode. Switched off, a C2 then stays in Active Standby with
     * the screen dark and this server running, where it otherwise sleeps
     * within ~2 minutes. Measured on an OLED42C24LA: 12.5W, against about 0W
     * in plain standby.
     */
    case 'alwaysReady':
      var arOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'general', settings: { alwaysOn: arOn ? 'on' : 'off' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    /*
     * LG's Always Ready (general/lifeOnScreenMode): switched off with the
     * remote, the TV shows LG's Always Ready screen, such as a clock, rather
     * than going dark. 'allEnabled' is LG's with-wallpaper mode, the one its
     * menu turns on; 'alwaysReady' is its without-wallpaper mode, which on a
     * C2 holds a dark screen at 12 W, as Always-on does, so only the wallpaper
     * mode is offered. Measured on an OLED42C24LA: 31 W with the clock.
     */
    case 'alwaysReadyScreen':
      var arsOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var setMode = function () {
        luna('com.webos.service.settings/setSystemSettings',
             { category: 'general', settings: { lifeOnScreenMode: arsOn ? 'allEnabled' : 'off' } },
             function (r) {
               telemetry.clearCache();
               cb({ ok: !!(r && r.returnValue) });
             });
      };
      // LG's alwaysready service draws the screen. It can be on the Apps
      // tab's list of background services to keep off, and then nothing shows.
      if (arsOn && servicesModule.isDisabled('alwaysready')) {
        return servicesModule.toggleService('alwaysready', false, setMode);
      }
      return setMode();

    /*
     * The five nightly hours when LG suspends Always-on, and a switched-off
     * TV sleeps fully. LG's own menu moves only the start and keeps the end five
     * hours later, "to keep your TV in the optimal condition"; so does this.
     */
    case 'alwaysReadyOffStart':
      var offHour = parseInt(String(value).split(':')[0], 10);
      if (!(offHour >= 0 && offHour <= 23)) return cb({ ok: false, error: msg('srv.arOff.badHour', 'the start must be an hour from 0 to 23') });
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'general', settings: {
                    alwaysOnDisableStartHour: String(offHour), alwaysOnDisableStartMinute: '0',
                    alwaysOnDisableEndHour: String((offHour + 5) % 24), alwaysOnDisableEndMinute: '0' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    // One of lgsettings.js's rows: { id, on }.
    case 'lgSetting':
      if (!value || typeof value.id !== 'string') return cb({ ok: false, error: 'lgSetting needs an id' });
      return lgSettings.set(value.id, value.on === true, function (r) {
        privacy.clearCache();
        cb(r);
      });

    case 'lgLogo':
      var logoOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'other', settings: { lgLogoDisplay: logoOn ? 'on' : 'off' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'wakeOnLan':
      var wolOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'network', settings: { wolwowlOnOff: wolOn ? 'true' : 'false' } },
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'serviceMenuLock':
      return oled.setServiceMenuLock(!!(value && value.locked), cb);

    case 'serviceMenuOpen':
      return oled.openServiceMenu(String((value && value.menu) || 'ezAdjust'), cb);

    case 'oledProtection':
      var prot = (value && typeof value === 'object') ? value : {};
      return oled.setOledProtection(String(prot.key || ''), !!prot.enabled, cb);

    case 'tvAppInstall':
      return doTvApp('install', cb);

    case 'tvAppRemove':
      return doTvApp('remove', cb);

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
                  function (r) {
                    telemetry.clearCache();
                    cb({ ok: !!(r && r.returnValue) });
                  });

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
                  { sourceId: toastSourceId, message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue), error: r && r.errorText }); },
                  toastSourceId);

    case 'tileHiding':
      if (isFromHbc()) return cb({ ok: false, error: tileHidingOffMsg });
      return appsModule.setTileHidingEnabled(!!value, function (r) {
        telemetry.clearCache();
        cb(r);
      });

    /*
     * Only reachable while the TV is in Active Standby (finishing panel
     * compensation, or held there by Always-on); in plain standby the B8
     * drops off the network within 5s and nothing here runs. power/powerOn
     * with a reason is what brings a C2 (webOS 9.2) back from Always-on;
     * cancelPowerOff only reverses a power-off still in progress, and
     * turnOnScreen only undoes screenOff. Those two remain for firmware
     * without powerOn.
     */
    case 'powerOn':
      if (!config.allowPower) return cb({ ok: false, error: msg('srv.powerOff', 'power actions disabled (set allowPower)') });
      var isOn = function (next) {
        setTimeout(function () {
          luna('com.webos.service.tvpower/power/getPowerState', {}, function (st) {
            next(!!(st && st.state === 'Active'));
          });
        }, 1500);
      };
      return luna('com.webos.service.tvpower/power/powerOn', { reason: 'remoteKey' }, function (p) {
        if (p && p.returnValue) return cb({ ok: true });
        luna('com.webos.service.tv.power/cancelPowerOff', {}, function () {
          isOn(function (on) {
            if (on) return cb({ ok: true });
            luna('com.webos.service.tvpower/power/turnOnScreen', {}, function (r) {
              cb({ ok: !!(r && r.returnValue), error: r && r.returnValue ? undefined : 'the TV stayed in standby' });
            });
          });
        });
      });

    case 'powerOff':
      if (!config.allowPower) return cb({ ok: false, error: msg('srv.powerOff', 'power actions disabled (set allowPower)') });
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
      if (!config.allowPower) return cb({ ok: false, error: msg('srv.powerOff', 'power actions disabled (set allowPower)') });
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
        if (r && r.ok && r.updated) {
          setTimeout(function () {
            if (!doRestartSelf()) console.error('update: no tvwebctl found - restart manually to apply');
          }, 600);
        }
        cb(r);
      });

    case 'blockTvUpdates':
      return privacy.setTvUpdatesBlocked(value === true || value === 'on' || value === 'true', function (r) {
        cb((r && r.ok) ? getUpdateSummary() : r);
      });

    case 'updateAutoCheck':
      return updater.setAutoCheck(value === true || value === 'on' || value === 'true', cb);

    case 'updateRollback':
      return updater.rollbackUpdate(function (r) {
        if (r && r.ok) setTimeout(function () { doRestartSelf(); }, 600);
        cb(r);
      });

    default:
      return cb({ ok: false, error: 'unknown action' });
  }
}

function init(opts) {
  opts = opts || {};
  if (opts.luna) luna = opts.luna;
  if (opts.clearLunaCache) clearLunaCache = opts.clearLunaCache;
  if (opts.config) config = opts.config;
  if (opts.telemetry) telemetry = opts.telemetry;
  if (opts.oled) oled = opts.oled;
  if (opts.privacy) privacy = opts.privacy;
  if (opts.services) servicesModule = opts.services;
  if (opts.screensavers) screensavers = opts.screensavers;
  if (opts.apps) appsModule = opts.apps;
  if (opts.lgSettings) lgSettings = opts.lgSettings;
  if (opts.updater) updater = opts.updater;
  if (opts.tvApp) tvAppFn = opts.tvApp;
  if (opts.restartSelf) restartSelfFn = opts.restartSelf;
  if (opts.updateSummary) updateSummaryFn = opts.updateSummary;
  if (opts.fromHomebrewChannel) fromHbcFn = opts.fromHomebrewChannel;
  if (opts.inputs) inputMap = opts.inputs;
  if (opts.browserApp) browserAppId = opts.browserApp;
  if (opts.toastSource) toastSourceId = opts.toastSource;
  if (opts.tileHidingOff) tileHidingOffMsg = opts.tileHidingOff;

  return {
    doControl: doControl,
    injectKey: injectKey,
    sendMediaKey: sendMediaKey,
    sendPlayPause: sendPlayPause
  };
}

module.exports = {
  init: init,
  doControl: doControl,
  injectKey: injectKey,
  sendMediaKey: sendMediaKey,
  sendPlayPause: sendPlayPause,
  RCU_KEY_CODES: RCU_KEY_CODES,
  RCU_KEYS: RCU_KEYS,
  KEY_BACK: KEY_BACK,
  SLEEP_TIMER_VALUES: SLEEP_TIMER_VALUES,
  ENERGY_SAVING_VALUES: ENERGY_SAVING_VALUES,
  LOGO_DIMMING_VALUES: LOGO_DIMMING_VALUES
};
