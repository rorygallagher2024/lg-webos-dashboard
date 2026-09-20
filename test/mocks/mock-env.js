/**
 * test/mocks/mock-env.js - Test environment interceptor for /proc, /sys, and Luna bus
 *
 * Intercepts fs calls for virtual procfs/sysfs paths and provides a mock
 * Luna-send dispatcher for testing telemetry and screensavers offline.
 */

var fs = require('fs');

var origReadFileSync = fs.readFileSync;
var origExistsSync = fs.existsSync;
var origReaddirSync = fs.readdirSync;
var origWriteFileSync = fs.writeFileSync;
var origUnlinkSync = fs.unlinkSync;
var origMkdirSync = fs.mkdirSync;

function createMockEnv(overrides) {
  overrides = overrides || {};
  var files = overrides.files || {};
  var lunaHandlers = overrides.luna || {};

  var mockFiles = {
    '/proc/meminfo': 'MemTotal:        1536000 kB\nMemFree:          120000 kB\nMemAvailable:     850000 kB\nBuffers:           45000 kB\nCached:           650000 kB\nSwapTotal:        524284 kB\nSwapFree:         404284 kB\n',
    '/proc/uptime': '12345.67 45678.90\n',
    '/proc/loadavg': '1.25 0.95 0.80 2/250 12345\n',
    '/proc/swaps': 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n/dev/block/zram0                        partition\t524284\t120000\t-1\n',
    '/proc/net/dev': 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 100000000    1000    0    0    0     0          0         0 50000000     800    0    0    0     0       0          0\nwlan0:  25000000     500    0    0    0     0          0         0 10000000     400    0    0    0     0       0          0\n',
    '/proc/net/wireless': 'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\nwlan0: 0000   76.  -63.  -256        0      0      0      0      0        0\n',
    '/proc/lg/pm/frequency': '1200000\n',
    '/proc/lg/pm/temperature': '48\n',
    '/proc/lg/pm/current_load': '35\n',
    '/proc/lg/pm/status': 'cpu_num: 4\nload: 25 30 15 20\n',
    '/sys/devices/system/cpu/online': '0-3\n',
    '/sys/block/mmcblk0/device/life_time': '0x01 0x01\n',
    '/sys/block/mmcblk0/device/pre_eol_info': '0x01\n',
    '/sys/class/net/wlan0/operstate': 'up\n',
    '/sys/class/net/wlan0/carrier': '1\n',
    '/sys/class/net/wlan0/address': '00:51:ed:99:7e:20\n',
    '/proc/lg/hdmi20/port0/status': 'horizontal-active: 3840\nvertical-active: 2160\npixel-clock-V: 60\npixel-clock: 594000\nconnected: on\ndeep-color-mode: 8bit\ninterlaced: no\n',
    '/proc/lg/hdmi20/port1/status': 'Sig:[3840]x[2160]@[120]Hz\nPixel Clk[1188000]\nconnected: on\ndeep-color-mode: 10bit\ninterlaced: no\n',
    '/proc/lg/pe/hdr_status': 'hdr_mode: HDR10\n',
    '/proc/lg/sys/status': 'gpu pll out: 550000000\nss: OFF\n',
    '/etc/issue': 'webOS 4.4.3\n',
    '/etc/starfish-release': 'Starfish 4.4.3\n',
    '/var/luna/preferences/environmentCondition': '{"boardTypeStr":"M16P","socChip":"M16P"}'
  };

  for (var k in files) {
    mockFiles[k] = files[k];
  }

  function mockReadFileSync(p, enc) {
    if (typeof p === 'string' && mockFiles.hasOwnProperty(p)) {
      var val = mockFiles[p];
      if (val === null) {
        var err = new Error('ENOENT: no such file or directory, open \'' + p + '\'');
        err.code = 'ENOENT';
        throw err;
      }
      return val;
    }
    return origReadFileSync.apply(fs, arguments);
  }

  function mockExistsSync(p) {
    if (typeof p === 'string') {
      if (mockFiles.hasOwnProperty(p)) {
        return mockFiles[p] !== null;
      }
      if (p.indexOf('/proc/') === 0 || p.indexOf('/sys/') === 0) {
        return false;
      }
    }
    return origExistsSync.apply(fs, arguments);
  }

  var defaultLuna = {
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.service.settings/getSystemSettings': {
      returnValue: true,
      settings: {
        pictureMode: 'expert1',
        soundOutput: 'tv_speaker',
        sleepTimer: 'off',
        screenShift: 'on',
        logoLuminanceAdjust: 'light'
      }
    },
    'com.webos.audio/getVolume': { returnValue: true, volume: 20, muted: false },
    'com.webos.audio/getSoundOutput': { returnValue: true, soundOutput: 'tv_speaker' },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.hdmi2' },
    'com.webos.applicationManager/listApps': {
      returnValue: true,
      apps: [
        { id: 'netflix', title: 'Netflix' },
        { id: 'youtube.leanback.v4', title: 'YouTube' }
      ]
    },
    'com.webos.applicationManager/listLaunchPoints': {
      returnValue: true,
      launchPoints: [
        { id: 'netflix', title: 'Netflix' },
        { id: 'youtube.leanback.v4', title: 'YouTube' }
      ]
    },
    'com.webos.service.eim/getAllInputStatus': {
      returnValue: true,
      devices: [
        { id: 'HDMI_1', port: 0, label: 'Blu-ray', activate: false, connected: true },
        { id: 'HDMI_2', port: 1, label: 'Apple TV', activate: true, connected: true }
      ]
    },
    'com.webos.service.config/getConfigs': {
      configs: {
        'tv.model.logoLight': false
      }
    }
  };

  for (var u in lunaHandlers) {
    defaultLuna[u] = lunaHandlers[u];
  }

  function mockLuna(uri, payload, cb, appId) {
    var res = defaultLuna[uri];
    if (typeof res === 'function') {
      res = res(payload, appId);
    }
    if (cb) {
      process.nextTick(function () {
        cb(res || { returnValue: false, errorText: 'not mocked: ' + uri }, JSON.stringify(res || {}));
      });
    }
  }

  function mockLunaCached(uri, payload, ttl, cb) {
    mockLuna(uri, payload, cb);
  }

  function mockWriteFileSync(p, data, enc) {
    if (typeof p === 'string' && (p.indexOf('/var/') === 0 || p.indexOf('/tmp/') === 0 || mockFiles.hasOwnProperty(p))) {
      mockFiles[p] = data;
      return;
    }
    return origWriteFileSync.apply(fs, arguments);
  }

  function mockUnlinkSync(p) {
    if (typeof p === 'string' && (p.indexOf('/var/') === 0 || p.indexOf('/tmp/') === 0 || mockFiles.hasOwnProperty(p))) {
      delete mockFiles[p];
      return;
    }
    return origUnlinkSync.apply(fs, arguments);
  }

  function mockMkdirSync(p) {
    if (typeof p === 'string' && (p.indexOf('/var/') === 0 || p.indexOf('/tmp/') === 0)) {
      return;
    }
    return origMkdirSync.apply(fs, arguments);
  }

  function install() {
    fs.readFileSync = mockReadFileSync;
    fs.existsSync = mockExistsSync;
    fs.writeFileSync = mockWriteFileSync;
    fs.unlinkSync = mockUnlinkSync;
    fs.mkdirSync = mockMkdirSync;
  }

  function restore() {
    fs.readFileSync = origReadFileSync;
    fs.existsSync = origExistsSync;
    fs.writeFileSync = origWriteFileSync;
    fs.unlinkSync = origUnlinkSync;
    fs.mkdirSync = origMkdirSync;
  }

  return {
    files: mockFiles,
    luna: defaultLuna,
    mockLuna: mockLuna,
    mockLunaCached: mockLunaCached,
    install: install,
    restore: restore
  };
}

module.exports = {
  createMockEnv: createMockEnv
};
