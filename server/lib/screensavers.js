/**
 * screensavers.js - Screensaver subsystem for webOS
 *
 * Manages custom QML screensavers, directory staging, appinfo.json patching,
 * runner compatibility between Flutter and QML on newer webOS versions,
 * and bind mounting over /usr/palm/applications/com.webos.app.screensaver.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;

var SCREENSAVER_APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';
var SCREENSAVER_DIR = '/var/lib/tvweb/screensaver';
var SCREENSAVER_MARKER = '.tvweb-screensaver';
var SCREENSAVER_LEVEL_MARKER = '.tvweb-brightness';
// Outside the staged directory, which is bind-mounted over the app and so hides
// the stock manifest whenever one of ours is in use.
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

// sam takes most of a minute to stop and come back (OLED55G42LW, webOS 10.3.1),
// and the screen stays dark meanwhile. Give up waiting well after that.
var SWITCH_POLL_MS = 3000;
var SWITCH_SETTLE_MS = 5000;
var SWITCH_TIMEOUT_MS = 150000;
var SWITCHING_ERROR = 'The TV is still switching screen savers. Try again in a minute.';

var SCREENSAVERS = {
  stock: {
    label: 'LG default',
    description: 'The screen saver the TV shipped with.'
  },
  clock: {
    label: 'Clock',
    description: 'A digital clock on black, moving to a new position every minute.',
    qml: 'screensavers/clock.qml'
  },
  starfield: {
    label: 'Starfield',
    description: 'A drifting cosmic starscape with occasional shooting stars.',
    qml: 'screensavers/starfield.qml'
  },
  fireworks: {
    label: 'Fireworks',
    description: 'Bursts of colour on black, a few seconds apart.',
    qml: 'screensavers/fireworks.qml'
  },
  bokeh: {
    label: 'Bokeh',
    description: 'Soft circles of light drifting in and out on black.',
    qml: 'screensavers/bokeh.qml'
  },
  vitals: {
    label: 'Panel vitals',
    description: "The TV's own readings - panel hours, pixel refresher countdown, temperature.",
    qml: 'screensavers/vitals.qml'
  }
};

var lunaFn = null;
var assetPathFn = null;
var configObj = null;
var injectKeyFn = null;
var keyBackVal = null;
var mapPowerStateFn = null;
var isScreenSaverFn = null;
var switchingSince = 0;

function clearStagedScreensaver() {
  try {
    var marker = path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  } catch (e) {}
  try {
    var levelMarker = path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER);
    if (fs.existsSync(levelMarker)) fs.unlinkSync(levelMarker);
  } catch (e) {}
  try {
    var appinfo = path.join(SCREENSAVER_DIR, 'appinfo.json');
    if (fs.existsSync(appinfo)) fs.unlinkSync(appinfo);
  } catch (e) {}
  try {
    var qmlDir = path.join(SCREENSAVER_DIR, 'qml');
    if (fs.existsSync(qmlDir)) {
      var files = fs.readdirSync(qmlDir);
      for (var i = 0; i < files.length; i++) {
        try { fs.unlinkSync(path.join(qmlDir, files[i])); } catch (e) {}
      }
      try { fs.rmdirSync(qmlDir); } catch (e) {}
    }
  } catch (e) {}
}

function unmountScreensaver(cb) {
  execFile('/bin/umount', [SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
    if (err) {
      return execFile('/bin/umount', ['-l', SCREENSAVER_APP_DIR], { timeout: 4000 }, function () {
        cb();
      });
    }
    cb();
  });
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  assetPathFn = opts.assetPath;
  configObj = opts.config;
  injectKeyFn = opts.injectKey;
  keyBackVal = opts.KEY_BACK;
  mapPowerStateFn = opts.mapPowerState;
  isScreenSaverFn = opts.isScreenSaver;

  // Auto-heal: If the screensaver is currently stock (no active bind-mount on SCREENSAVER_APP_DIR),
  // but an orphaned marker remains in SCREENSAVER_DIR, remove it so the boot hook does not
  // re-mount a stale screensaver on the next cold reboot.
  if (screensaverMode() === 'stock') {
    clearStagedScreensaver();
    rememberStockType();
  }
}

function manifestType(json) {
  try { return JSON.parse(json).type || null; } catch (e) { return null; }
}

// Only valid while the stock app is showing, i.e. nothing is mounted over it.
function rememberStockType(json) {
  try {
    if (json === undefined) json = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
    var type = manifestType(json);
    if (type) fs.writeFileSync(STOCK_TYPE_FILE, type);
  } catch (e) {}
}

// True where LG's screen saver runs on another runner than ours (Flutter on
// webOS 10), so going to or from it restarts sam. Unknown until the stock
// manifest has been seen once.
function slowSwitch() {
  try {
    var t = fs.readFileSync(STOCK_TYPE_FILE, 'utf8').trim();
    return !!t && t !== 'qml';
  } catch (e) {}
  return false;
}

function switching() {
  if (switchingSince && Date.now() - switchingSince > SWITCH_TIMEOUT_MS) switchingSince = 0;
  return !!switchingSince;
}

// sam answers again once it is back; until then luna calls to it time out.
function waitForRunner(type) {
  switchingSince = Date.now();
  var since = switchingSince;
  (function poll() {
    setTimeout(function () {
      if (switchingSince !== since) return;
      if (!switching()) return;
      lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (r) {
        if (switchingSince !== since) return;
        if (r && r.appInfo && r.appInfo.type === type) {
          return setTimeout(function () {
            if (switchingSince === since) switchingSince = 0;
          }, SWITCH_SETTLE_MS);
        }
        poll();
      });
    }, SWITCH_POLL_MS);
  })();
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) {}
}

function screensaverLevel() {
  try {
    var v = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_LEVEL_MARKER), 'utf8').trim();
    if (v === 'bright') return 'bright';
  } catch (e) {}
  return 'dim';
}

function screensaverMode() {
  try {
    var m = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_MARKER), 'utf8').trim();
    if (SCREENSAVERS[m] && m !== 'stock') return m;
  } catch (e) {}
  return 'stock';
}

function screensaverList() {
  var cur = screensaverMode();
  var out = [];
  for (var k in SCREENSAVERS) {
    out.push({
      id: k,
      label: SCREENSAVERS[k].label,
      description: SCREENSAVERS[k].description,
      active: k === cur,
      available: k === 'stock' || !!(assetPathFn && assetPathFn(SCREENSAVERS[k].qml))
    });
  }
  return {
    ok: true,
    current: cur,
    level: screensaverLevel(),
    modes: out,
    writable: !!(configObj && configObj.allowControl),
    slowSwitch: slowSwitch(),
    switching: switching()
  };
}

function stageScreensaverAppinfo() {
  var stock = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
  rememberStockType(stock);
  var out = stock;
  try {
    var info = JSON.parse(stock);
    info.type = 'qml';
    info.main = 'qml/main.qml';
    out = JSON.stringify(info, null, 2);
  } catch (e) {
    console.error('screensaver: stock appinfo.json did not parse, staging it unchanged: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'appinfo.json'), out);
}

function ensureScreensaverRunner(cb) {
  var staged;
  try {
    staged = JSON.parse(fs.readFileSync(
      path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8')).type;
  } catch (e) {
    return cb(false);
  }
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (r) {
    var cached = r && r.appInfo && r.appInfo.type;
    // No answer means the bus is not up yet. Leave the service alone.
    if (!cached || cached === staged) return cb(false);
    console.log('screensaver: sam holds the app as "' + cached + '" and it is now "'
                + staged + '" - restarting sam so it reads the manifest again');
    execFile('/bin/systemctl', ['restart', '--no-block', 'sam'], { timeout: 10000 }, function (e) {
      if (e) console.error('screensaver: could not restart sam: ' + e.message);
      else waitForRunner(staged);
      cb(!e);
    });
  });
}

function settleScreensaverApp(cb) {
  ensureScreensaverRunner(function (samRestarted) {
    if (samRestarted) return cb();
    restartScreensaverApp(cb);
  });
}

function writeScreensaverQml(src, level) {
  var port = (configObj && configObj.port) || 8080;
  var token = configObj && configObj.token;
  var qml = fs.readFileSync(src, 'utf8')
    .replace(/__TVWEB_URL__/g,
      'http://127.0.0.1:' + port + '/api/stats' +
      (token ? '?k=' + encodeURIComponent(token) : ''))
    .replace(/__TVWEB_LEVEL__/g, level === 'bright' ? '1' : '0');
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', 'main.qml'), qml);

  try {
    var from = path.dirname(src);
    var files = fs.readdirSync(from);
    for (var i = 0; i < files.length; i++) {
      if (/\.qml$/i.test(files[i])) continue;
      fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', files[i]),
                       fs.readFileSync(path.join(from, files[i])));
    }
  } catch (e) {
    console.error('screensaver: could not stage its files: ' + e.message);
  }
  fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_LEVEL_MARKER), level === 'bright' ? 'bright' : 'dim');
}

function setScreensaver(mode, level, cb) {
  if (!SCREENSAVERS[mode]) return cb({ ok: false, error: 'unknown screen saver: ' + mode });
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  level = (level === 'bright') ? 'bright' : 'dim';

  unmountScreensaver(function () {
    if (mode === 'stock') {
      clearStagedScreensaver();
      return settleScreensaverApp(function () {
        cb({ ok: screensaverMode() === 'stock', current: screensaverMode(), level: screensaverLevel(),
             switching: switching() });
      });
    }

    var src = assetPathFn ? assetPathFn(SCREENSAVERS[mode].qml) : null;
    if (!src) return cb({ ok: false, error: 'screen saver asset missing: ' + SCREENSAVERS[mode].qml });

    try {
      mkdirp(path.join(SCREENSAVER_DIR, 'qml'));
      stageScreensaverAppinfo();
      writeScreensaverQml(src, level);
      fs.writeFileSync(path.join(SCREENSAVER_DIR, SCREENSAVER_MARKER), mode);
    } catch (e) {
      return cb({ ok: false, error: 'could not stage the screen saver: ' + e.message });
    }

    execFile('/bin/mount', ['--bind', SCREENSAVER_DIR, SCREENSAVER_APP_DIR], { timeout: 4000 }, function (err) {
      settleScreensaverApp(function () {
        var now = screensaverMode();
        cb({
          ok: !err && now === mode,
          current: now,
          level: screensaverLevel(),
          switching: switching(),
          error: (!err && now === mode) ? undefined : 'the mount did not take'
        });
      });
    });
  });
}

function restageScreensaver() {
  var mode = screensaverMode();
  if (mode === 'stock') return;
  var src = assetPathFn ? assetPathFn(SCREENSAVERS[mode].qml) : null;
  if (!src) return;
  try {
    var staged = path.join(SCREENSAVER_DIR, 'qml', 'main.qml');
    var before = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : '';
    writeScreensaverQml(src, screensaverLevel());
    if (fs.readFileSync(staged, 'utf8') !== before) {
      console.log('screensaver: restaged "' + mode + '" from a newer asset');
    }
  } catch (e) {
    console.error('screensaver: could not restage ' + mode + ': ' + e.message);
  }
}

function restartScreensaverApp(cb) {
  if (!lunaFn) return cb();
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var isSS = isScreenSaverFn && mapPowerStateFn && isScreenSaverFn(mapPowerStateFn(pw && pw.state));
    if (!isSS) {
      return lunaFn('com.webos.applicationManager/closeByAppId',
                    { id: 'com.webos.app.screensaver' }, function () { cb(); });
    }
    if (!injectKeyFn || !keyBackVal) {
      return cb();
    }
    injectKeyFn(keyBackVal, function () {
      setTimeout(function () {
        lunaFn('com.webos.applicationManager/closeByAppId', { id: 'com.webos.app.screensaver' }, function () {
          setTimeout(function () {
            lunaFn('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function () { cb(); });
          }, 1500);
        });
      }, 1500);
    });
  });
}

function trigger(cb) {
  if (!lunaFn) return cb({ ok: false, error: 'luna bus not available' });
  // Asking tvpower for a screen saver while sam is down can park it at
  // "Screen Saver Ready" until a reboot.
  if (switching()) return cb({ ok: false, error: SWITCHING_ERROR });
  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var isSS = isScreenSaverFn && mapPowerStateFn && isScreenSaverFn(mapPowerStateFn(pw && pw.state));
    if (isSS) {
      if (!injectKeyFn || !keyBackVal) {
        return cb({ ok: false, error: 'key injection not available' });
      }
      return injectKeyFn(keyBackVal, function (ok) {
        cb(ok ? { ok: true } : { ok: false, error: 'could not reach the remote input device' });
      });
    }

    lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var fgId = (fg && fg.appId) ? String(fg.appId).replace('com.webos.app.', '') : '';
      if (/^hdmi[1-4]$/.test(fgId) || fgId === 'livetv') {
        return cb({ ok: false, error: 'the screen saver is only available from an app, not from ' + fgId });
      }
      lunaFn('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function (r) {
        if (r && r.returnValue) return cb({ ok: true });
        cb({
          ok: false,
          error: (r && r.errorText)
            ? 'the TV would not start a screen saver here: ' + r.errorText
            : 'the TV would not start a screen saver from ' + (fgId || 'this source')
        });
      });
    });
  });
}

module.exports = {
  SCREENSAVER_APP_DIR: SCREENSAVER_APP_DIR,
  SCREENSAVER_DIR: SCREENSAVER_DIR,
  SCREENSAVERS: SCREENSAVERS,
  init: init,
  clearStagedScreensaver: clearStagedScreensaver,
  unmountScreensaver: unmountScreensaver,
  screensaverLevel: screensaverLevel,
  screensaverMode: screensaverMode,
  screensaverList: screensaverList,
  switching: switching,
  setScreensaver: setScreensaver,
  restageScreensaver: restageScreensaver,
  trigger: trigger
};
