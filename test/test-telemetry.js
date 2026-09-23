/**
 * test/test-telemetry.js - Unit tests for telemetry subsystem
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var telemetry = require('../server/lib/telemetry');

var oledMock = {
  detectOled: function (cb) { cb(true); },
  getIsOled: function () { return true; },
  refreshOledStats: function (settings, ps, cb) {
    cb({ panel_hours: 3500, screen_shift: 'on', logo_dimming: 'light' });
  }
};

var privacyMock = {
  isAdBlockActive: function () { return true; },
  collectPrivacy: function (cb) {
    cb({ adblock: { enabled: true, mode: 'full' } });
  }
};

var screensaversMock = {
  screensaverMode: function () { return 'stock'; },
  screensaverLevel: function () { return 'dim'; }
};

telemetry.init({
  luna: mockEnv.mockLuna,
  lunaCached: mockEnv.mockLunaCached,
  config: { port: 8080, allowControl: true },
  oled: oledMock,
  privacy: privacyMock,
  screensavers: screensaversMock,
  tvwebVersion: '0.36.0',
  mapPowerState: function (raw) {
    return { raw: raw, label: 'On', systemOn: true, screenOn: true };
  },
  isScreenSaver: function () { return false; }
});

console.log('Running test-telemetry.js ...');

// 1. eMMC wear tests
(function testDynamicRange() {
  var f = telemetry.formatDynamicRange;
  assert.strictEqual(f('sdr'), 'SDR');
  assert.strictEqual(f(''), 'SDR');
  assert.strictEqual(f('hdr'), 'HDR');
  assert.strictEqual(f('hdrALLM'), 'HDR \u00b7 Low latency');
  assert.strictEqual(f('dolbyHdrALLM'), 'Dolby Vision \u00b7 Low latency');
  assert.strictEqual(f('technicolorHdr'), 'Technicolor HDR');
  assert.strictEqual(f('hlg'), 'HLG');
  assert.strictEqual(f('hdr10Plus'), 'HDR10 Plus');
  console.log('  dynamic range names are readable');
})();

(function testEmmc() {
  var info = telemetry.emmcInfo();
  assert.strictEqual(info.wear, '0-10%', 'Expected 0-10% wear');
  assert.strictEqual(info.eol, 'Normal', 'Expected Normal EOL');
  assert.ok(info.health.indexOf('>90%') !== -1, 'Expected healthy drive');
  console.log('  ✓ emmcInfo parses healthy multi-region eMMC');
})();

// 2. onlineCpus tests
(function testOnlineCpus() {
  var cpus = telemetry.onlineCpus();
  assert.deepEqual(cpus, [0, 1, 2, 3], 'Expected 4 online cores');

  // Test custom range strings
  mockEnv.files['/sys/devices/system/cpu/online'] = '0,2-3\n';
  assert.deepEqual(telemetry.onlineCpus(), [0, 2, 3], 'Expected disjoint core range');

  // Test fallback to status line
  mockEnv.files['/sys/devices/system/cpu/online'] = null;
  assert.deepEqual(telemetry.onlineCpus('cpu_num: 2'), [0, 1], 'Expected fallback to cpu_num count');
  console.log('  ✓ onlineCpus handles ranges and status fallbacks');
})();

// 3. socMhz tests
(function testSocMhz() {
  // webOS 4 kHz format: 1200000 -> 1200
  mockEnv.files['/proc/lg/pm/frequency'] = '1200000\n';
  assert.strictEqual(telemetry.socMhz(), 1200, 'Expected 1200 MHz from kHz input');

  // webOS 9+ MHz format: 1200 -> 1200
  mockEnv.files['/proc/lg/pm/frequency'] = '1200\n';
  assert.strictEqual(telemetry.socMhz(), 1200, 'Expected 1200 MHz from MHz input');

  // Out of bounds clock
  mockEnv.files['/proc/lg/pm/frequency'] = '50\n';
  assert.strictEqual(telemetry.socMhz(), null, 'Expected null for impossible clock');
  console.log('  ✓ socMhz correctly scales kHz vs MHz across webOS versions');
})();

// 4. swapBacking tests
(function testSwapBacking() {
  mockEnv.files['/proc/swaps'] = 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n/dev/block/zram0 partition\t524284\t120000\t-1\n';
  assert.strictEqual(telemetry.swapBacking(), 'zram', 'Expected zram swap backing');
  console.log('  ✓ swapBacking identifies zram');
})();

// 5. wifi tests
(function testWifi() {
  var w = telemetry.wifi();
  assert.ok(w, 'Expected wifi object');
  assert.strictEqual(w.link, 76, 'Expected link quality 76');
  assert.strictEqual(w.level, -63, 'Expected RSSI -63');
  console.log('  ✓ wifi parses wireless status and dBm level');
})();

// 6. HDMI ports tests
(function testHdmiPorts() {
  var ports = telemetry.hdmiPorts();
  assert.ok(ports.length >= 2, 'Expected at least 2 HDMI ports');

  // Port 0: HDMI 2.0 format
  var p0 = ports[0];
  assert.strictEqual(p0.connected, true);
  assert.strictEqual(p0.resolution, '3840x2160');
  assert.strictEqual(p0.refreshHz, 60);

  // Port 1: HDMI 2.1 format (Sig: format)
  var p1 = ports[1];
  assert.strictEqual(p1.connected, true);
  assert.strictEqual(p1.resolution, '3840x2160');
  assert.strictEqual(p1.refreshHz, 120);
  console.log('  ✓ hdmiPorts parses both HDMI 2.0 and HDMI 2.1 PHY timing nodes');
})();

// 7. Format helpers
(function testFormatters() {
  assert.strictEqual(telemetry.formatPicMode('expert1'), 'ISF Expert (Bright)');
  assert.strictEqual(telemetry.formatSoundOutput('tv_speaker'), 'TV Speaker');
  assert.strictEqual(telemetry.formatDynamicRange('hdr10'), 'HDR10');
  console.log('  ✓ formatters map modes and dynamic ranges');
})();

// 8. Capabilities test
(function testCapabilities() {
  var caps = telemetry.getCapabilities({ isOled: true });
  assert.strictEqual(caps.isOled, true);
  assert.strictEqual(caps.thermalPresent, true);
  assert.strictEqual(caps.emmcWearPresent, true);
  console.log('  ✓ getCapabilities produces filter flags');
})();

// 9. Installed apps tests
telemetry.refreshInstalledApps(function (apps) {
  assert.ok(Array.isArray(apps), 'Expected array of apps');
  assert.strictEqual(apps.length, 2);
  assert.strictEqual(apps[0].id, 'netflix');
  assert.strictEqual(apps[1].id, 'youtube.leanback.v4');
  console.log('  ✓ refreshInstalledApps parses apps from listApps');

  // Test webOS 6+ shape where listApps returns launchPoints (issue #145)
  telemetry.clearCache();
  var origListApps = mockEnv.luna['com.webos.applicationManager/listApps'];
  mockEnv.luna['com.webos.applicationManager/listApps'] = {
    returnValue: true,
    launchPoints: [
      { id: 'netflix', title: 'Netflix' },
      { id: 'com.webos.app.discovery', title: 'Apps' },
      { id: 'com.webos.app.container', title: 'Container' },
      { id: 'hidden.app', title: 'Hidden', visible: false }
    ]
  };

  telemetry.refreshInstalledApps(function (lpApps) {
    assert.strictEqual(lpApps.length, 2);
    assert.strictEqual(lpApps[0].id, 'com.webos.app.discovery');
    assert.strictEqual(lpApps[1].id, 'netflix');
    console.log('  ✓ refreshInstalledApps parses launchPoints array (webOS 6+ / issue #145)');

    // Test fallback to listLaunchPoints when listApps returns empty/fails
    telemetry.clearCache();
    mockEnv.luna['com.webos.applicationManager/listApps'] = { returnValue: false };
    mockEnv.luna['com.webos.applicationManager/listLaunchPoints'] = {
      returnValue: true,
      launchPoints: [
        { id: 'amazon', title: 'Prime Video' }
      ]
    };

    telemetry.refreshInstalledApps(function (fallbackApps) {
      assert.strictEqual(fallbackApps.length, 1);
      assert.strictEqual(fallbackApps[0].id, 'amazon');
      console.log('  ✓ refreshInstalledApps falls back to listLaunchPoints');

      // Restore original handlers
      mockEnv.luna['com.webos.applicationManager/listApps'] = origListApps;
      mockEnv.luna['com.webos.applicationManager/listLaunchPoints'] = {
        returnValue: true,
        launchPoints: [
          { id: 'netflix', title: 'Netflix' },
          { id: 'youtube.leanback.v4', title: 'YouTube' }
        ]
      };

      // 10. Full collectStats test (async)
      telemetry.clearCache();
      telemetry.collectStats(function (stats) {
        assert.ok(stats, 'Expected stats payload');
        assert.strictEqual(stats.ok, true);
        assert.strictEqual(stats.tvwebVersion, '0.36.0');
        assert.strictEqual(stats.temp, 48);
        assert.ok(stats.mem && stats.mem.total > 0, 'Expected mem stats');
        assert.ok(stats.swap && stats.swap.total > 0, 'Expected swap stats');
        assert.strictEqual(stats.wifi.level, -63);
        assert.ok(stats.oled && stats.oled.panel_hours === 3500);
        assert.ok(Array.isArray(stats.apps) && stats.apps.length === 2);

        console.log('  ✓ collectStats aggregates full telemetry payload including apps');
        console.log('ALL test-telemetry.js assertions passed!\n');
        mockEnv.restore();
      });
    });
  });
});
