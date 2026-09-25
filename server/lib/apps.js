/**
 * apps.js - Application management and tile visibility for webOS.
 *
 * Provides:
 * 1. Hiding non-removable built-in LG system tiles via appinfo.json bind-mounts
 *    (survives reboots, non-destructive to rootfs, fully reversible).
 * 2. Uninstalling user/store removable applications via Luna appInstallService.
 * 3. Enforcing a strict safety denylist of protected system services.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4 (LG OLED B8).
 */

var msg = require('./say').msg;
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;

var OVERRIDE_DIR = '/var/lib/tvweb/appinfo-overrides';
var HIDDEN_APPS_FILE = '/var/lib/tvweb/hidden_apps';
// A saved web page's title as the browser set it, kept on its first rename so
// clearing the name can put it back.
var PAGE_TITLES_FILE = '/var/lib/tvweb/saved_page_titles.json';
var BROWSER_ID = 'com.webos.app.browser';
var TILE_HIDING_FLAG_FILE = '/var/lib/tvweb/tile_hiding_enabled';

var APP_BASES = [
  '/media/system/apps/usr/palm/applications',
  '/usr/palm/applications',
  '/mnt/otncabi/usr/palm/applications',
  '/mnt/otycabi/usr/palm/applications'
];

var PROTECTED_APP_IDS = {
  'com.tvweb.dashboard': true,
  'org.webosbrew.hbchannel': true,
  'com.webos.app.livetv': true,
  'com.palm.app.settings': true,
  'com.webos.app.settings': true,
  'com.webos.app.container': true,
  'container': true,
  'com.webos.app.inputcommon': true,
  'inputcommon': true,
  'com.webos.app.home': true,
  'com.webos.app.firstuse': true,
  'firstuse': true,
  'com.webos.app.eula': true,
  'eula': true,
  'com.webos.app.webapphost': true,
  'webapphost': true,
  // Its only tile is a bookmark it re-adds at boot; hiding it adds more.
  'airplay': true
};

/*
 * AirPlay has no tile of its own (its appinfo says visible: false); its tile is
 * a bookmark that airplay-adaptor adds at boot when it finds none. On the B8
 * (webOS 4) that check misses the bookmarks already there, and it added one
 * 39s into a boot with two present, so every boot leaves another. The first is
 * kept and the rest removed, once at start and again after the adaptor runs.
 */
function dedupeAirPlay() {
  lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
    var extra = ((r && r.launchPoints) || []).filter(function (p) {
      return p.id === 'airplay' && p.lptype === 'bookmark';
    }).slice(1);
    extra.forEach(function (p) {
      lunaFn('com.webos.applicationManager/removeLaunchPoint', { launchPointId: p.launchPointId }, function () {});
    });
    if (extra.length) console.log('apps: removed ' + extra.length + ' duplicate AirPlay tile' +
                                  (extra.length === 1 ? '' : 's'));
  });
}

// A TV that hid AirPlay before it was protected still hides it at boot, since
// the boot hook reads the hidden list itself.
function releaseAirPlay() {
  var lines = [];
  try { lines = fs.readFileSync(HIDDEN_APPS_FILE, 'utf8').split('\n'); } catch (e) { return; }
  if (lines.map(function (l) { return l.trim(); }).indexOf('airplay') === -1) return;
  try {
    fs.writeFileSync(HIDDEN_APPS_FILE, lines.filter(function (l) { return l.trim() && l.trim() !== 'airplay'; })
      .map(function (l) { return l.trim() + '\n'; }).join(''));
    var ovr = path.join(OVERRIDE_DIR, 'airplay.json');
    if (fs.existsSync(ovr)) fs.unlinkSync(ovr);
  } catch (e2) {
    return console.error('apps: could not take AirPlay off the hidden list: ' + e2.message);
  }
  console.log('apps: AirPlay can no longer be hidden; unhidden');
}

var lunaFn = null;
var configObj = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  configObj = opts.config;
  if (lunaFn) {
    releaseAirPlay();
    dedupeAirPlay();
    setTimeout(dedupeAirPlay, 180000);
  }
}

function isProtected(id) {
  if (!id || typeof id !== 'string') return true;
  if (PROTECTED_APP_IDS[id]) return true;
  if (id.indexOf('com.webos.app.hdmi') === 0) return true;
  if (id.indexOf('com.webos.app.input') === 0) return true;
  return false;
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) {}
}

function readHiddenAppsList() {
  var map = {};
  try {
    if (fs.existsSync(HIDDEN_APPS_FILE)) {
      var lines = fs.readFileSync(HIDDEN_APPS_FILE, 'utf8').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var id = lines[i].trim();
        if (id && !isProtected(id)) {
          map[id] = true;
        }
      }
    }
  } catch (e) {
    console.error('apps: could not read hidden apps file: ' + e.message);
  }
  return map;
}

function writeHiddenAppsList(map) {
  try {
    mkdirp(path.dirname(HIDDEN_APPS_FILE));
    var ids = Object.keys(map).sort();
    var content = ids.length > 0 ? ids.join('\n') + '\n' : '';
    fs.writeFileSync(HIDDEN_APPS_FILE, content);
  } catch (e) {
    console.error('apps: could not write hidden apps file: ' + e.message);
  }
}

function findAllAppinfoPaths(appId) {
  if (!appId || typeof appId !== 'string') return [];
  var paths = [];
  for (var i = 0; i < APP_BASES.length; i++) {
    var p = path.join(APP_BASES[i], appId, 'appinfo.json');
    if (fs.existsSync(p)) paths.push(p);
  }
  return paths;
}

function findAppinfoPath(appId) {
  var paths = findAllAppinfoPaths(appId);
  return paths.length > 0 ? paths[0] : null;
}

function findAppDir(appId) {
  if (!appId || typeof appId !== 'string') return null;
  for (var i = 0; i < APP_BASES.length; i++) {
    var d = path.join(APP_BASES[i], appId);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

function isTileHidingEnabled() {
  if (fs.existsSync(TILE_HIDING_FLAG_FILE)) {
    try {
      return fs.readFileSync(TILE_HIDING_FLAG_FILE, 'utf8').trim() === '1';
    } catch (e) {
      return false;
    }
  }
  // One-time legacy migration: if flag file has not been created yet,
  // check if an existing hidden_apps file has entries.
  if (fs.existsSync(HIDDEN_APPS_FILE)) {
    try {
      var lines = fs.readFileSync(HIDDEN_APPS_FILE, 'utf8').trim();
      if (lines.length > 0) {
        mkdirp(path.dirname(TILE_HIDING_FLAG_FILE));
        fs.writeFileSync(TILE_HIDING_FLAG_FILE, '1\n', 'utf8');
        return true;
      }
    } catch (e) {}
  }
  return false;
}

function setTileHidingEnabled(enabled, cb) {
  if (!configObj || !configObj.allowControl) {
    if (cb) cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
    return;
  }
  enabled = !!enabled;
  try {
    mkdirp(path.dirname(TILE_HIDING_FLAG_FILE));
    fs.writeFileSync(TILE_HIDING_FLAG_FILE, enabled ? '1\n' : '0\n', 'utf8');
  } catch (e) {}
  if (!enabled) {
    var hiddenMap = readHiddenAppsList();
    var ids = Object.keys(hiddenMap);
    var i = 0;
    function unmountNext() {
      if (i >= ids.length) {
        return restartSam(function (restarted) {
          if (cb) cb({ ok: true, tileHidingEnabled: false, samRestarted: restarted });
        });
      }
      var appId = ids[i++];
      unmountAllForApp(appId, unmountNext);
    }
    unmountNext();
  } else {
    try {
      mkdirp(path.dirname(TILE_HIDING_FLAG_FILE));
      fs.writeFileSync(TILE_HIDING_FLAG_FILE, '1\n', 'utf8');
    } catch (e) {}
    var hiddenMap = readHiddenAppsList();
    var ids = Object.keys(hiddenMap);
    var i = 0;
    function remountNext() {
      if (i >= ids.length) {
        return restartSam(function (restarted) {
          if (cb) cb({ ok: true, tileHidingEnabled: true, samRestarted: restarted });
        });
      }
      var appId = ids[i++];
      var ovr = path.join(OVERRIDE_DIR, appId + '.json');
      if (fs.existsSync(ovr)) {
        var tgts = findAllAppinfoPaths(appId);
        var j = 0;
        function mountTarget() {
          if (j >= tgts.length) return remountNext();
          var tgt = tgts[j++];
          execFile('/bin/mount', ['--bind', ovr, tgt], { timeout: 4000 }, function () {
            mountTarget();
          });
        }
        mountTarget();
      } else {
        remountNext();
      }
    }
    remountNext();
  }
}

/**
 * Platform-aware fast SAM restart with active foreground app preservation.
 * On systemd sets (C2, webOS 9), LunaExecutable (AirPlay) ignores SIGTERM and hangs
 * systemctl restart for 90s. Killing LunaExecutable + systemctl kill -s 9 terminates
 * the cgroup immediately, triggering systemd on-failure restart in <1s.
 * On Upstart sets (B8, webOS 4), initctl or pkill -9 triggers upstart respawn in ~1s.
 * If a non-home app (like an active HDMI port or Live TV) was in the foreground,
 * it is automatically relaunched so the user is never stranded on the Home screen.
 */
function restartSam(cb) {
  function executeRestart(savedAppId) {
    var cmd = 'if command -v systemctl >/dev/null 2>&1; then ' +
              'killall -9 LunaExecutable >/dev/null 2>&1 || true; ' +
              'systemctl kill -s 9 sam.service >/dev/null 2>&1 || systemctl restart --no-block sam >/dev/null 2>&1 || true; ' +
              'elif command -v initctl >/dev/null 2>&1; then ' +
              'initctl restart sam >/dev/null 2>&1 || pkill -9 -x sam >/dev/null 2>&1 || true; ' +
              'else ' +
              'pkill -9 -x sam >/dev/null 2>&1 || true; ' +
              'fi';
    execFile('/bin/sh', ['-c', cmd], { timeout: 6000 }, function (err) {
      if (err) console.error('apps: restartSam error: ' + err.message);
      if (savedAppId && savedAppId !== 'com.webos.app.home' && lunaFn) {
        var attempts = 0;
        function tryRestore() {
          attempts++;
          lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (resp) {
            if (resp && resp.returnValue) {
              lunaFn('com.webos.applicationManager/launch', { id: savedAppId }, function () {
                if (cb) cb(!err);
              });
            } else if (attempts < 10) {
              setTimeout(tryRestore, 200);
            } else {
              if (cb) cb(!err);
            }
          });
        }
        setTimeout(tryRestore, 300);
      } else {
        if (cb) cb(!err);
      }
    });
  }

  if (lunaFn) {
    lunaFn('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
      var savedAppId = (fg && fg.returnValue && fg.appId) ? fg.appId : null;
      executeRestart(savedAppId);
    });
  } else {
    executeRestart(null);
  }
}

function isMounted(filePath, cb) {
  execFile('/bin/mount', [], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(false);
    var pat = ' ' + filePath + ' ';
    cb(String(stdout || '').indexOf(pat) !== -1);
  });
}

function umountFile(filePath, cb) {
  execFile('/bin/umount', ['-l', filePath], { timeout: 4000 }, function () {
    if (cb) cb();
  });
}

function unmountAllForApp(appId, cb) {
  var tgts = findAllAppinfoPaths(appId);
  var i = 0;
  var next = function () {
    if (i >= tgts.length) {
      if (cb) cb();
      return;
    }
    var tgt = tgts[i++];
    var appDir = path.dirname(tgt);
    umountFile(tgt, function () {
      umountFile(appDir, function () {
        umountFile(tgt, function () {
          next();
        });
      });
    });
  };
  next();
}

/**
 * Resolves an icon file path on disk for an app.
 */
function getIconPath(appId, cb) {
  if (!appId || typeof appId !== 'string') return cb(null);

  // Check developer or cryptofs apps first
  var devAppPath = path.join('/media/developer/apps/usr/palm/applications', appId);
  var cryptoAppPath = path.join('/media/cryptofs/apps/usr/palm/applications', appId);
  var appDir = null;

  if (fs.existsSync(devAppPath)) appDir = devAppPath;
  else if (fs.existsSync(cryptoAppPath)) appDir = cryptoAppPath;
  else appDir = findAppDir(appId);

  if (!appDir) return cb(null);

  var appinfoPath = path.join(appDir, 'appinfo.json');
  fs.readFile(appinfoPath, 'utf8', function (err, raw) {
    if (err || !raw) return cb(null);
    try {
      var info = JSON.parse(raw);
      var iconRel = info.largeIcon || info.icon || 'icon.png';
      // Strip leading $ if present (Enact convention)
      if (iconRel.charAt(0) === '$') iconRel = iconRel.slice(1);
      var basePath = info.sysAssetsBasePath ? path.join(appDir, info.sysAssetsBasePath) : appDir;
      var candidates = [
        path.join(basePath, iconRel),
        path.join(basePath, 'hd1080', iconRel),
        path.join(basePath, 'hd720', iconRel),
        path.join(appDir, iconRel),
        path.join(appDir, 'hd1080', iconRel),
        path.join(appDir, 'icon.png'),
        path.join(appDir, 'assets', 'icon.png')
      ];
      for (var c = 0; c < candidates.length; c++) {
        if (fs.existsSync(candidates[c])) return cb(candidates[c]);
      }
    } catch (e) {}
    cb(null);
  });
}

/**
 * Enumerates all installed removable apps and non-removable built-in system tiles.
 */
function getApps(cb) {
  var hiddenMap = readHiddenAppsList();

  if (!lunaFn) {
    return cb({
      ok: false,
      error: 'luna bus not available',
      installed: [],
      systemTiles: [],
      hiddenCount: Object.keys(hiddenMap).length,
      writable: false
    });
  }

  lunaFn('com.webos.applicationManager/listApps', {}, function (appsRes) {
    var rawApps = (appsRes && (appsRes.apps || appsRes.launchPoints)) || [];

    lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (lpRes) {
      var rawLps = (lpRes && (lpRes.launchPoints || lpRes.apps)) || [];

      var appMap = {};
      var i, a, id;

      // Index all applications from listApps
      for (i = 0; i < rawApps.length; i++) {
        a = rawApps[i];
        if (a && a.id) {
          appMap[a.id] = {
            id: a.id,
            title: a.title || a.id,
            version: a.version || '',
            vendor: a.vendor || '',
            folderPath: a.folderPath || '',
            systemApp: !!a.systemApp,
            removable: !!a.removable,
            icon: a.largeIcon || a.icon || ''
          };
        }
      }

      // Merge / supplement with listLaunchPoints
      var lpMap = {};
      /** @type {any[]} */
      var savedPages = [];
      var originals = readPageTitles();
      for (i = 0; i < rawLps.length; i++) {
        a = rawLps[i];
        /*
         * A web page saved to the home screen is a bookmark tile of the
         * browser's. Merged by app id it would rename the browser after the
         * page and hide every page but one, so each is listed on its own.
         * Other apps have bookmark tiles too (AirPlay's only tile, an HDMI
         * input given a name) and stay with their app.
         */
        if (a && a.id === BROWSER_ID && a.lptype === 'bookmark') {
          savedPages.push({
            launchPointId: a.launchPointId,
            title: a.title || '',
            appId: a.id,
            address: (a.params && (a.params.target || a.params.url)) || '',
            renamed: originals.hasOwnProperty(a.launchPointId)
          });
          continue;
        }
        if (a && a.id) {
          lpMap[a.id] = true;
          if (!appMap[a.id]) {
            appMap[a.id] = {
              id: a.id,
              title: a.title || a.id,
              version: a.version || '',
              vendor: a.vendor || '',
              folderPath: '',
              systemApp: !!a.systemApp,
              removable: a.removable !== false,
              icon: a.largeIcon || a.icon || ''
            };
          } else {
            if (a.title) appMap[a.id].title = a.title;
            if (a.icon && !appMap[a.id].icon) appMap[a.id].icon = a.icon;
            if (a.largeIcon && !appMap[a.id].icon) appMap[a.id].icon = a.largeIcon;
            if (a.removable !== undefined) appMap[a.id].removable = a.removable;
            if (a.systemApp !== undefined) appMap[a.id].systemApp = a.systemApp;
          }
        }
      }

      var installed = [];
      var systemTiles = [];

      var allIds = Object.keys(appMap);
      for (i = 0; i < allIds.length; i++) {
        id = allIds[i];
        var item = appMap[id];
        if (isProtected(id)) continue;

        var isDev = item.folderPath.indexOf('/media/developer') === 0;
        var isCrypto = item.folderPath.indexOf('/media/cryptofs') === 0;
        var isBuiltIn = item.folderPath.indexOf('/usr/palm') === 0 ||
                        item.folderPath.indexOf('/mnt/otncabi') === 0 ||
                        item.folderPath.indexOf('/mnt/otycabi') === 0 ||
                        item.folderPath.indexOf('/media/system') === 0 ||
                        (!isDev && !isCrypto && findAppinfoPath(id) !== null);

        if (!isBuiltIn && (item.removable || isDev || isCrypto)) {
          // Removable user or store app
          installed.push({
            id: item.id,
            title: item.title,
            version: item.version,
            vendor: item.vendor,
            iconUrl: '/api/apps/icon?id=' + encodeURIComponent(item.id),
            removable: true,
            folderPath: item.folderPath
          });
        } else if ((lpMap[item.id] || hiddenMap[item.id]) && (item.systemApp || isBuiltIn)) {
          // System built-in tile on home screen ribbon (or currently hidden from it)
          systemTiles.push({
            id: item.id,
            title: item.title,
            iconUrl: '/api/apps/icon?id=' + encodeURIComponent(item.id),
            hidden: !!hiddenMap[item.id],
            systemApp: true,
            removable: false
          });
        }
      }

      // Ensure any app recorded in hiddenMap is present in systemTiles even if SAM omitted it
      var hiddenKeys = Object.keys(hiddenMap);
      for (i = 0; i < hiddenKeys.length; i++) {
        var hid = hiddenKeys[i];
        var found = false;
        for (var j = 0; j < systemTiles.length; j++) {
          if (systemTiles[j].id === hid) { found = true; break; }
        }
        if (!found && !isProtected(hid)) {
          var appinfoFile = findAppinfoPath(hid);
          var title = hid;
          if (appinfoFile) {
            try {
              var parsed = JSON.parse(fs.readFileSync(appinfoFile, 'utf8'));
              if (parsed.title) title = parsed.title;
            } catch (e) {}
          }
          systemTiles.push({
            id: hid,
            title: title,
            iconUrl: '/api/apps/icon?id=' + encodeURIComponent(hid),
            hidden: true,
            systemApp: true,
            removable: false
          });
        }
      }

      installed.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
      systemTiles.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });

      cb({
        ok: true,
        installed: installed,
        systemTiles: systemTiles,
        savedPages: savedPages,
        hiddenCount: Object.keys(hiddenMap).length,
        tileHidingEnabled: isTileHidingEnabled(),
        writable: !!(configObj && configObj.allowControl)
      });
    });
  });
}

/**
 * Hides a built-in system tile by staging visible:false and bind-mounting.
 */
function hideTile(appId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }
  if (isProtected(appId)) {
    return cb({ ok: false, error: msg('srv.apps.protectedHide', 'Protected core system app cannot be hidden') });
  }

  var tgts = findAllAppinfoPaths(appId);
  if (tgts.length === 0) {
    return cb({ ok: false, error: 'appinfo.json not found for ' + appId });
  }

  unmountAllForApp(appId, function () {
    var stock;
    try {
      stock = JSON.parse(fs.readFileSync(tgts[0], 'utf8'));
    } catch (e) {
      return cb({ ok: false, error: 'Failed to read stock appinfo: ' + e.message });
    }

    stock.visible = false;
    mkdirp(OVERRIDE_DIR);
    var ovr = path.join(OVERRIDE_DIR, appId + '.json');
    try {
      fs.writeFileSync(ovr, JSON.stringify(stock, null, 2));
    } catch (e) {
      return cb({ ok: false, error: 'Failed to write override appinfo: ' + e.message });
    }

    var i = 0;
    var mountErrors = [];
    var mountNext = function () {
      if (i >= tgts.length) {
        if (mountErrors.length === tgts.length) {
          return cb({ ok: false, error: 'Bind mount failed: ' + mountErrors.join('; ') });
        }

        var hiddenMap = readHiddenAppsList();
        hiddenMap[appId] = true;
        writeHiddenAppsList(hiddenMap);
        try {
          mkdirp(path.dirname(TILE_HIDING_FLAG_FILE));
          fs.writeFileSync(TILE_HIDING_FLAG_FILE, '1\n', 'utf8');
        } catch (e) {}

        return restartSam(function (restarted) {
          cb({
            ok: true,
            id: appId,
            hidden: true,
            samRestarted: restarted
          });
        });
      }

      var tgt = tgts[i++];
      execFile('/bin/mount', ['--bind', ovr, tgt], { timeout: 4000 }, function (mountErr) {
        if (mountErr) mountErrors.push(mountErr.message);
        mountNext();
      });
    };

    mountNext();
  });
}

/**
 * Unhides a previously hidden tile by unmounting the override and restarting SAM.
 */
function unhideTile(appId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }

  var ovr = path.join(OVERRIDE_DIR, appId + '.json');
  unmountAllForApp(appId, function () {
    try { if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch (e) {}
    var hiddenMap = readHiddenAppsList();
    delete hiddenMap[appId];
    writeHiddenAppsList(hiddenMap);

    restartSam(function (restarted) {
      cb({
        ok: true,
        id: appId,
        hidden: false,
        samRestarted: restarted
      });
    });
  });
}

/**
 * Restores all currently hidden tiles.
 */
function unhideAllTiles(cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }

  var hiddenMap = readHiddenAppsList();
  var ids = Object.keys(hiddenMap);

  var unmountAllRemaining = function () {
    if (ids.length === 0) {
      writeHiddenAppsList({});
      return restartSam(function (restarted) {
        cb({ ok: true, restoredCount: Object.keys(hiddenMap).length, samRestarted: restarted });
      });
    }

    var curId = ids.shift();
    var ovr = path.join(OVERRIDE_DIR, curId + '.json');
    unmountAllForApp(curId, function () {
      try { if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch (e) {}
      unmountAllRemaining();
    });
  };

  unmountAllRemaining();
}

/**
 * Uninstalls a removable user or store app via Luna appInstallService.
 */
function readPageTitles() {
  try { return JSON.parse(fs.readFileSync(PAGE_TITLES_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

/*
 * A name the browser could reach: a domain ending in letters (bbc.co.uk), an
 * IPv4 address (a device on the network) or localhost. "12345" parses as a
 * host but is none of these.
 */
function isWebHost(host) {
  var h = String(host).toLowerCase();
  if (h === 'localhost') return true;
  var ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) return ip.slice(1).every(function (n) { return +n <= 255; });
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h);
}

/*
 * The address a saved page opens, with https:// assumed when none is given.
 * Only http(s): anything else would be handed to the browser as written, and
 * the dashboard is reachable by everyone on the network.
 */
function pageUrl(address) {
  var url = String(address || '').trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  var m = /^https?:\/\/([^\/?#:\s]+)(:\d{1,5})?([\/?#][^\s]*)?$/i.exec(url);
  if (!m || !isWebHost(m[1])) return null;
  return { url: url, host: m[1].replace(/^www\./i, '') };
}

var BAD_ADDRESS = 'enter a web address, such as bbc.co.uk';

function findSavedPage(lpId, cb) {
  lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (r) {
    var lps = (r && r.launchPoints) || [];
    for (var i = 0; i < lps.length; i++) {
      if (lps[i].launchPointId === lpId && lps[i].lptype === 'bookmark' && lps[i].id === BROWSER_ID) return cb(lps[i]);
    }
    cb(null);
  });
}

/*
 * The tile keeps its id and its place on the home screen: updateLaunchPoint
 * takes a new title and a new address alike. An empty name puts back the title
 * the browser gave the page. An address left out is kept as it is.
 */
function editSavedPage(launchPointId, title, address, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  var lpId = String(launchPointId || '');
  var name = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!lpId) return cb({ ok: false, error: 'missing page' });
  if (name.length > 60) return cb({ ok: false, error: msg('srv.apps.nameTooLong', 'names are limited to 60 characters') });
  var target = null;
  if (address != null && String(address).trim()) {
    target = pageUrl(address);
    if (!target) return cb({ ok: false, error: BAD_ADDRESS });
  }

  findSavedPage(lpId, function (lp) {
    if (!lp) return cb({ ok: false, error: msg('srv.apps.pageGone', 'that saved page is no longer on the TV') });
    var originals = readPageTitles();
    if (!name) {
      name = originals.hasOwnProperty(lpId) ? originals[lpId] : lp.title;
      delete originals[lpId];
    } else if (name !== lp.title && !originals.hasOwnProperty(lpId)) {
      originals[lpId] = lp.title;
    }
    var change = { launchPointId: lpId, title: name };
    if (target) {
      var params = {};
      for (var k in (lp.params || {})) params[k] = lp.params[k];
      params.target = target.url;
      change.params = params;
    }
    lunaFn('com.webos.applicationManager/updateLaunchPoint', change, function (u) {
      if (!u || u.returnValue !== true) return cb({ ok: false, error: msg('srv.tvRefused', 'the TV would not change it') });
      try { fs.writeFileSync(PAGE_TITLES_FILE, JSON.stringify(originals), 'utf8'); } catch (e) {}
      cb({ ok: true, title: name, address: target ? target.url : undefined });
    });
  });
}

/*
 * The same tile the browser makes when a page is saved from it.
 */
function addSavedPage(address, title, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  var target = pageUrl(address);
  if (!target) return cb({ ok: false, error: BAD_ADDRESS });
  var name = String(title == null ? '' : title).replace(/\s+/g, ' ').trim() || target.host;
  if (name.length > 60) return cb({ ok: false, error: msg('srv.apps.nameTooLong', 'names are limited to 60 characters') });
  lunaFn('com.webos.applicationManager/addLaunchPoint',
         { id: BROWSER_ID, title: name, params: { target: target.url } }, function (r) {
    if (!r || r.returnValue !== true) return cb({ ok: false, error: msg('srv.apps.addRefused', 'the TV would not add it') });
    cb({ ok: true, launchPointId: r.launchPointId, title: name });
  });
}

/*
 * Takes the tile off the home screen, as the TV's own remove does: the browser
 * and anything else installed are untouched, and no app is opened or closed.
 */
function removeSavedPage(launchPointId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  var lpId = String(launchPointId || '');
  if (!lpId) return cb({ ok: false, error: 'missing page' });
  findSavedPage(lpId, function (lp) {
    if (!lp) return cb({ ok: false, error: msg('srv.apps.pageGone', 'that saved page is no longer on the TV') });
    lunaFn('com.webos.applicationManager/removeLaunchPoint', { launchPointId: lpId }, function (x) {
      if (!x || x.returnValue !== true) return cb({ ok: false, error: msg('srv.apps.removeRefused', 'the TV would not remove it') });
      var originals = readPageTitles();
      if (originals.hasOwnProperty(lpId)) {
        delete originals[lpId];
        try { fs.writeFileSync(PAGE_TITLES_FILE, JSON.stringify(originals), 'utf8'); } catch (e) {}
      }
      cb({ ok: true });
    });
  });
}

function uninstallApp(appId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: msg('srv.controlsOff.apps', 'Control is disabled in server configuration') });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }
  if (isProtected(appId)) {
    return cb({ ok: false, error: msg('srv.apps.protectedUninstall', 'Protected core application cannot be uninstalled') });
  }
  if (!lunaFn) {
    return cb({ ok: false, error: 'Luna service not available' });
  }

  var handleSuccess = function () {
    // Wait for the app removal to complete asynchronously in SAM / appInstallService
    var start = Date.now();
    var poll = function () {
      lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
        var apps = (res && res.apps) || [];
        var stillThere = false;
        for (var i = 0; i < apps.length; i++) {
          if (apps[i] && apps[i].id === appId) {
            stillThere = true;
            break;
          }
        }
        if (!stillThere || (Date.now() - start) >= 3000) {
          return cb({ ok: true, id: appId });
        }
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 300);
  };

  // Attempt standard removal first
  lunaFn('com.webos.appInstallService/remove', { id: appId }, function (res) {
    if (res && res.returnValue) {
      return handleSuccess();
    }

    // Fall back to dev/remove if standard removal failed (e.g. sideloaded developer app)
    lunaFn('com.webos.appInstallService/dev/remove', { id: appId }, function (devRes) {
      if (devRes && devRes.returnValue) {
        return handleSuccess();
      }
      var errMsg = (devRes && devRes.errorText) || (res && res.errorText) || 'Failed to uninstall app';
      cb({ ok: false, error: errMsg, id: appId });
    });
  });
}

module.exports = {
  init: init,
  isProtected: isProtected,
  getApps: getApps,
  getIconPath: getIconPath,
  findAllAppinfoPaths: findAllAppinfoPaths,
  findAppinfoPath: findAppinfoPath,
  APP_BASES: APP_BASES,
  hideTile: hideTile,
  unhideTile: unhideTile,
  unhideAllTiles: unhideAllTiles,
  uninstallApp: uninstallApp,
  editSavedPage: editSavedPage,
  removeSavedPage: removeSavedPage,
  addSavedPage: addSavedPage,
  isWebHost: isWebHost,
  restartSam: restartSam,
  readHiddenAppsList: readHiddenAppsList,
  writeHiddenAppsList: writeHiddenAppsList,
  isTileHidingEnabled: isTileHidingEnabled,
  setTileHidingEnabled: setTileHidingEnabled,
  PROTECTED_APP_IDS: PROTECTED_APP_IDS
};
