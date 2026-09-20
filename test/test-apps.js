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
      title: 'TV Dashboard',
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

var failures = 0;
var asyncRemaining = 0;

tests.forEach(function (t) {
  if (t[1].length > 0) {
    asyncRemaining++;
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
