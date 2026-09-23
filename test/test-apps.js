/**
 * test/test-apps.js - Unit tests for application management and tile hiding
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var apps = require('../server/lib/apps');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('isProtected strictly protects core TV system services', function () {
  var protectedIds = [
    'com.tvweb.dashboard',
    'org.webosbrew.hbchannel',
    'com.webos.app.livetv',
    'com.palm.app.settings',
    'com.webos.app.settings',
    'com.webos.app.container',
    'container',
    'com.webos.app.inputcommon',
    'inputcommon',
    'com.webos.app.home',
    'com.webos.app.firstuse',
    'firstuse',
    'com.webos.app.eula',
    'eula',
    'com.webos.app.webapphost',
    'webapphost',
    'com.webos.app.hdmi1',
    'com.webos.app.hdmi2',
    'com.webos.app.hdmi3',
    'com.webos.app.hdmi4'
  ];

  protectedIds.forEach(function (id) {
    assert.strictEqual(apps.isProtected(id), true, id + ' must be protected');
  });
});

test('Home Assistant names apps, keeping each option distinct', function () {
  var ha = require('../server/lib/ha');
  var byId = ha.appNames([{ id: 'netflix', title: 'Netflix' }, { id: 'x.other', title: 'Netflix' },
                          { id: 'no.title' }]);
  assert.strictEqual(byId.netflix, 'Netflix');
  assert.strictEqual(byId['x.other'], 'Netflix (x.other)');
  assert.strictEqual(byId['no.title'], 'no.title');
  assert.strictEqual(ha.appNames([])['youtube.leanback.v4'], 'YouTube');
});

test('isProtected allows normal user and LG bloatware apps', function () {
  var normalIds = [
    'com.webos.app.igallery',
    'com.webos.app.music',
    'com.webos.app.photovideo',
    'com.webos.app.tvuserguide',
    'com.webos.app.sportsteamsettings',
    'com.webos.app.homeconnect',
    'com.webos.app.lifeonscreen',
    'com.webos.app.camera',
    'youtube.leanback.v4',
    'netflix',
    'spotify-beehive'
  ];

  normalIds.forEach(function (id) {
    assert.strictEqual(apps.isProtected(id), false, id + ' should not be protected');
  });
});

test('isProtected rejects invalid, non-string, or empty IDs', function () {
  assert.strictEqual(apps.isProtected(''), true);
  assert.strictEqual(apps.isProtected(null), true);
  assert.strictEqual(apps.isProtected(undefined), true);
  assert.strictEqual(apps.isProtected(123), true);
});

test('hideTile rejects protected apps and invalid IDs', function () {
  apps.init({ config: { allowControl: true } });

  apps.hideTile('com.webos.app.livetv', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  apps.hideTile('com.tvweb.dashboard', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  apps.hideTile('../etc/passwd', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Invalid') !== -1);
  });
});

test('uninstallApp strictly rejects protected applications', function () {
  apps.init({ config: { allowControl: true } });

  apps.uninstallApp('com.tvweb.dashboard', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });

  apps.uninstallApp('org.webosbrew.hbchannel', function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('Protected') !== -1);
  });
});

test('uninstallApp invokes appInstallService and waits for removal from listApps', function (done) {
  var appsInList = [{ id: 'test.app.dummy' }];
  var removeCalled = false;

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.appInstallService/remove') {
      removeCalled = true;
      setTimeout(function () {
        appsInList = [];
      }, 50);
      return cb({ returnValue: true });
    }
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: appsInList });
    }
    cb({ returnValue: false });
  };

  apps.init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.uninstallApp('test.app.dummy', function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.id, 'test.app.dummy');
    assert.strictEqual(removeCalled, true);
    assert.strictEqual(appsInList.length, 0);
    if (done) done();
  });
});

test('readHiddenAppsList filters out protected IDs', function () {
  var hiddenFile = '/var/lib/tvweb/hidden_apps';
  mockEnv.files[hiddenFile] = 'com.webos.app.igallery\ncom.webos.app.livetv\ncom.webos.app.music\n';

  try {
    var map = apps.readHiddenAppsList();
    assert.strictEqual(map['com.webos.app.igallery'], true);
    assert.strictEqual(map['com.webos.app.music'], true);
    assert.strictEqual(map['com.webos.app.livetv'], undefined, 'Protected app must be filtered from hidden map');
  } finally {
    delete mockEnv.files[hiddenFile];
  }
});

test('getApps segregates removable apps and built-in system tiles', function (done) {
  var mockAppsList = [
    {
      id: 'youtube.leanback.v4',
      title: 'YouTube',
      removable: true,
      systemApp: false,
      folderPath: '/media/cryptofs/apps/usr/palm/applications/youtube.leanback.v4'
    },
    {
      id: 'com.webos.app.igallery',
      title: 'Gallery',
      removable: false,
      systemApp: true,
      folderPath: '/usr/palm/applications/com.webos.app.igallery'
    },
    {
      id: 'com.tvweb.dashboard',
      title: 'Glasshouse',
      removable: true,
      systemApp: false,
      folderPath: '/media/developer/apps/usr/palm/applications/com.tvweb.dashboard'
    },
    {
      id: 'com.webos.app.livetv',
      title: 'Live TV',
      removable: false,
      systemApp: true,
      folderPath: '/usr/palm/applications/com.webos.app.livetv'
    }
  ];

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: mockAppsList });
    }
    if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      return cb({ launchPoints: mockAppsList });
    }
    cb({ returnValue: false });
  };

  apps.init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.getApps(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.writable, true);

    // Protected apps must be excluded
    var allIds = res.installed.concat(res.systemTiles).map(function (x) { return x.id; });
    assert.strictEqual(allIds.indexOf('com.tvweb.dashboard'), -1);
    assert.strictEqual(allIds.indexOf('com.webos.app.livetv'), -1);

    // YouTube in installed
    var yt = res.installed.filter(function (x) { return x.id === 'youtube.leanback.v4'; })[0];
    assert.ok(yt, 'YouTube should be in installed');
    assert.strictEqual(yt.removable, true);

    // Gallery in systemTiles
    var gal = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.igallery'; })[0];
    assert.ok(gal, 'Gallery should be in systemTiles');
    assert.strictEqual(gal.systemApp, true);
    assert.strictEqual(gal.hidden, false);

    if (done) done();
  });
});

test('APP_BASES prioritizes /media/system/apps', function () {
  assert.strictEqual(apps.APP_BASES[0], '/media/system/apps/usr/palm/applications');
});

test('findAllAppinfoPaths discovers apps across multiple bases', function () {
  var p1 = '/media/system/apps/usr/palm/applications/com.webos.app.browser/appinfo.json';
  var p2 = '/mnt/otncabi/usr/palm/applications/com.webos.app.browser/appinfo.json';
  mockEnv.files[p1] = JSON.stringify({ id: 'com.webos.app.browser', version: '4.1.15' });
  mockEnv.files[p2] = JSON.stringify({ id: 'com.webos.app.browser', version: '2.0.0' });

  try {
    var all = apps.findAllAppinfoPaths('com.webos.app.browser');
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0], p1);
    assert.strictEqual(all[1], p2);
    assert.strictEqual(apps.findAppinfoPath('com.webos.app.browser'), p1);
  } finally {
    delete mockEnv.files[p1];
    delete mockEnv.files[p2];
  }
});

test('getApps categorizes /media/system apps as built-in system tiles', function (done) {
  var mockAppsList = [
    {
      id: 'com.webos.app.browser',
      title: 'Web Browser',
      removable: false,
      systemApp: true,
      folderPath: '/media/system/apps/usr/palm/applications/com.webos.app.browser'
    },
    {
      id: 'com.webos.app.lgchannels',
      title: 'LG Channels',
      removable: false,
      systemApp: true,
      folderPath: '/media/system/apps/usr/palm/applications/com.webos.app.lgchannels'
    }
  ];

  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/listApps') {
      return cb({ apps: mockAppsList });
    }
    if (uri === 'com.webos.applicationManager/listLaunchPoints') {
      return cb({ launchPoints: mockAppsList });
    }
    cb({ returnValue: false });
  };

  apps.init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.getApps(function (res) {
    assert.strictEqual(res.ok, true);
    var browser = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.browser'; })[0];
    assert.ok(browser, 'Web Browser should be in systemTiles');
    assert.strictEqual(browser.systemApp, true);

    var lgch = res.systemTiles.filter(function (x) { return x.id === 'com.webos.app.lgchannels'; })[0];
    assert.ok(lgch, 'LG Channels should be in systemTiles');
    assert.strictEqual(lgch.systemApp, true);

    if (done) done();
  });
});

test('isTileHidingEnabled detects flag file and auto-migrates from hidden_apps', function () {
  var flagFile = '/var/lib/tvweb/tile_hiding_enabled';
  var hiddenFile = '/var/lib/tvweb/hidden_apps';

  delete mockEnv.files[flagFile];
  delete mockEnv.files[hiddenFile];
  assert.strictEqual(apps.isTileHidingEnabled(), false);

  mockEnv.files[flagFile] = '1\n';
  assert.strictEqual(apps.isTileHidingEnabled(), true);

  mockEnv.files[flagFile] = '0\n';
  assert.strictEqual(apps.isTileHidingEnabled(), false, 'Explicit 0 in flag file must evaluate to false');

  delete mockEnv.files[flagFile];
  mockEnv.files[hiddenFile] = 'com.webos.app.igallery\n';
  assert.strictEqual(apps.isTileHidingEnabled(), true);
  assert.strictEqual(mockEnv.files[flagFile].trim(), '1', 'Should auto-create flag file with 1 when hidden_apps has content');

  // Even if hidden_apps exists, if flag file is set to '0', it stays disabled
  mockEnv.files[flagFile] = '0\n';
  assert.strictEqual(apps.isTileHidingEnabled(), false, 'Explicitly disabled flag must override existing hidden_apps file');

  delete mockEnv.files[flagFile];
  delete mockEnv.files[hiddenFile];
});

test('setTileHidingEnabled toggles flag file and requires allowControl', function (done) {
  var flagFile = '/var/lib/tvweb/tile_hiding_enabled';

  // Disabled when allowControl is false
  apps.init({ config: { allowControl: false } });
  apps.setTileHidingEnabled(true, function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.indexOf('disabled') !== -1);

    // Enabled when allowControl is true
    apps.init({
      config: { allowControl: true },
      luna: function (uri, params, cb) { cb({ returnValue: true }); }
    });

    apps.setTileHidingEnabled(true, function (r1) {
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r1.tileHidingEnabled, true);
      assert.strictEqual(mockEnv.files[flagFile].trim(), '1');

      apps.setTileHidingEnabled(false, function (r2) {
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r2.tileHidingEnabled, false);
        assert.strictEqual(mockEnv.files[flagFile].trim(), '0');
        if (done) done();
      });
    });
  });
});

test('restartSam preserves and relaunches active foreground app', function (done) {
  var launchedApp = null;
  var mockLuna = function (uri, params, cb) {
    if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
      return cb({ returnValue: true, appId: 'com.webos.app.hdmi2' });
    }
    if (uri === 'com.webos.applicationManager/launch') {
      launchedApp = params.id;
      return cb({ returnValue: true });
    }
    cb({ returnValue: true });
  };

  apps.init({
    luna: mockLuna,
    config: { allowControl: true }
  });

  apps.restartSam(function () {
    assert.strictEqual(launchedApp, 'com.webos.app.hdmi2', 'Must relaunch saved HDMI foreground app');
    if (done) done();
  });
});

var failures = 0;
var asyncRemaining = 0;

tests.forEach(function (t) {
  if (t[1].length > 0) asyncRemaining++;
});

tests.forEach(function (t) {
  if (t[1].length > 0) {
    try {
      t[1](function () {
        console.log('  ✓ ' + t[0]);
        asyncRemaining--;
        if (asyncRemaining === 0) finish();
      });
    } catch (e) {
      failures++;
      console.log('  ✗ ' + t[0] + '\n      ' + e.message);
      asyncRemaining--;
      if (asyncRemaining === 0) finish();
    }
  } else {
    try {
      t[1]();
      console.log('  ✓ ' + t[0]);
    } catch (e) {
      failures++;
      console.log('  ✗ ' + t[0] + '\n      ' + e.message);
    }
  }
});

function finish() {
  mockEnv.restore();
  if (failures === 0) {
    console.log('ALL test-apps.js assertions passed!');
  }
  process.exit(failures ? 1 : 0);
}

if (asyncRemaining === 0) finish();
