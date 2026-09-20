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

var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;

var OVERRIDE_DIR = '/var/lib/tvweb/appinfo-overrides';
var HIDDEN_APPS_FILE = '/var/lib/tvweb/hidden_apps';

var APP_BASES = [
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
  'webapphost': true
};

var lunaFn = null;
var configObj = null;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  configObj = opts.config;
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

function findAppinfoPath(appId) {
  if (!appId || typeof appId !== 'string') return null;
  for (var i = 0; i < APP_BASES.length; i++) {
    var p = path.join(APP_BASES[i], appId, 'appinfo.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findAppDir(appId) {
  if (!appId || typeof appId !== 'string') return null;
  for (var i = 0; i < APP_BASES.length; i++) {
    var d = path.join(APP_BASES[i], appId);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

/**
 * Platform-aware fast SAM restart.
 * On systemd sets (C2, webOS 9), LunaExecutable (AirPlay) ignores SIGTERM and hangs
 * systemctl restart for 90s. Killing LunaExecutable + systemctl kill -s 9 terminates
 * the cgroup immediately, triggering systemd on-failure restart in <1s.
 * On Upstart sets (B8, webOS 4), initctl or pkill -9 triggers upstart respawn in ~1s.
 */
function restartSam(cb) {
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
    if (cb) cb(!err);
  });
}

function isMounted(filePath, cb) {
  execFile('/bin/mount', [], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(false);
    var pat = ' ' + filePath + ' ';
    cb(String(stdout || '').indexOf(pat) !== -1);
  });
}

function umountFile(filePath, cb) {
  execFile('/bin/umount', [filePath], { timeout: 4000 }, function () {
    if (cb) cb();
  });
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
      var fullPath = path.join(basePath, iconRel);
      if (fs.existsSync(fullPath)) return cb(fullPath);
      // Fallback directly under appDir
      fullPath = path.join(appDir, iconRel);
      if (fs.existsSync(fullPath)) return cb(fullPath);
      fullPath = path.join(appDir, 'icon.png');
      if (fs.existsSync(fullPath)) return cb(fullPath);
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
      for (i = 0; i < rawLps.length; i++) {
        a = rawLps[i];
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
                        (!isDev && !isCrypto && findAppinfoPath(id) !== null);

        if (item.removable || isDev || isCrypto) {
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
        hiddenCount: Object.keys(hiddenMap).length,
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
    return cb({ ok: false, error: 'Control is disabled in server configuration' });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }
  if (isProtected(appId)) {
    return cb({ ok: false, error: 'Protected core system app cannot be hidden' });
  }

  var tgt = findAppinfoPath(appId);
  if (!tgt) {
    return cb({ ok: false, error: 'appinfo.json not found for ' + appId });
  }

  var stock;
  try {
    stock = JSON.parse(fs.readFileSync(tgt, 'utf8'));
  } catch (e) {
    return cb({ ok: false, error: 'Failed to read stock appinfo: ' + e.message });
  }

  stock.visible = false;
  mkdirp(OVERRIDE_DIR);
  var ovr = path.join(OVERRIDE_DIR, appId + '.json');
  try {
    fs.writeFileSync(ovr, JSON.stringify(stock, null, 2));
  } catch (e) {
    return cb({ ok: false, error: 'Failed to write override file: ' + e.message });
  }

  execFile('/bin/mount', ['--bind', ovr, tgt], { timeout: 4000 }, function (mountErr) {
    if (mountErr) {
      return cb({ ok: false, error: 'Bind mount failed: ' + mountErr.message });
    }

    var hiddenMap = readHiddenAppsList();
    hiddenMap[appId] = true;
    writeHiddenAppsList(hiddenMap);

    restartSam(function (restarted) {
      cb({
        ok: true,
        id: appId,
        hidden: true,
        samRestarted: restarted
      });
    });
  });
}

/**
 * Unhides a previously hidden tile by unmounting the override and restarting SAM.
 */
function unhideTile(appId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: 'Control is disabled in server configuration' });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }

  var tgt = findAppinfoPath(appId);
  var ovr = path.join(OVERRIDE_DIR, appId + '.json');

  var unmountNext = function () {
    if (tgt) {
      umountFile(tgt, function () {
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
    } else {
      try { if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch (e) {}
      var hiddenMap = readHiddenAppsList();
      delete hiddenMap[appId];
      writeHiddenAppsList(hiddenMap);
      cb({ ok: true, id: appId, hidden: false });
    }
  };

  unmountNext();
}

/**
 * Restores all currently hidden tiles.
 */
function unhideAllTiles(cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: 'Control is disabled in server configuration' });
  }

  var hiddenMap = readHiddenAppsList();
  var ids = Object.keys(hiddenMap);

  var unmountRemaining = function () {
    if (ids.length === 0) {
      writeHiddenAppsList({});
      return restartSam(function (restarted) {
        cb({ ok: true, restoredCount: Object.keys(hiddenMap).length, samRestarted: restarted });
      });
    }
    var curId = ids.shift();
    var tgt = findAppinfoPath(curId);
    var ovr = path.join(OVERRIDE_DIR, curId + '.json');
    if (tgt) {
      umountFile(tgt, function () {
        try { if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch (e) {}
        unmountRemaining();
      });
    } else {
      try { if (fs.existsSync(ovr)) fs.unlinkSync(ovr); } catch (e) {}
      unmountRemaining();
    }
  };

  unmountRemaining();
}

/**
 * Uninstalls a removable user or store app via Luna appInstallService.
 */
function uninstallApp(appId, cb) {
  if (!configObj || !configObj.allowControl) {
    return cb({ ok: false, error: 'Control is disabled in server configuration' });
  }
  if (!appId || typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId)) {
    return cb({ ok: false, error: 'Invalid app ID format' });
  }
  if (isProtected(appId)) {
    return cb({ ok: false, error: 'Protected core application cannot be uninstalled' });
  }
  if (!lunaFn) {
    return cb({ ok: false, error: 'Luna service not available' });
  }

  // Attempt standard removal first
  lunaFn('com.webos.appInstallService/remove', { id: appId }, function (res) {
    if (res && res.returnValue) {
      return cb({ ok: true, id: appId });
    }

    // Fall back to dev/remove if standard removal failed (e.g. sideloaded developer app)
    lunaFn('com.webos.appInstallService/dev/remove', { id: appId }, function (devRes) {
      if (devRes && devRes.returnValue) {
        return cb({ ok: true, id: appId });
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
  hideTile: hideTile,
  unhideTile: unhideTile,
  unhideAllTiles: unhideAllTiles,
  uninstallApp: uninstallApp,
  restartSam: restartSam,
  readHiddenAppsList: readHiddenAppsList,
  writeHiddenAppsList: writeHiddenAppsList,
  PROTECTED_APP_IDS: PROTECTED_APP_IDS
};
