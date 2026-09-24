/**
 * telemetry.js - Device telemetry, hardware detection, and procfs profiling for webOS
 *
 * Gathers system hardware info, CPU/memory stats, process tree profiling,
 * HDMI PHY receiver diagnostics, network throughput, and audio/picture configurations.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;
var ha = require('./ha');

var SOUND_OUTPUT_MAP = ha.SOUND_OUTPUT_MAP;

// LG's own reading where it exists. Models without it (the 55QNED826QB, webOS
// 7.6) still have the kernel's thermal zone, in millidegrees: 68000 = 68 C.
var LG_THERMAL = '/proc/lg/pm/temperature';
var SYS_THERMAL = '/sys/class/thermal/thermal_zone0/temp';
var THERMAL_SOURCE = fs.existsSync(LG_THERMAL) ? LG_THERMAL : fs.existsSync(SYS_THERMAL) ? SYS_THERMAL : null;
var THERMAL_PRESENT = !!THERMAL_SOURCE;
var EMMC_WEAR_PRESENT = fs.existsSync('/sys/block/mmcblk0/device/life_time');

var lunaFn = null;
var lunaCachedFn = null;
var configObj = null;
var oledModule = null;
var privacyModule = null;
var screensaversModule = null;
var tvwebVersionStr = '0.0.0';
var mapPowerStateFn = null;
var isScreenSaverFn = null;

var HARDWARE_INFO = {
  webos: null,
  socArch: null,
  ram: null,
  refreshRate: null,
  eyeSensor: null,
  cell: null,
  tconFirmware: null,
  tconModule: null
};

var hasLogoLight = null;   // null = not yet determined
var hasLightSensor = false;
var hasMediaState = false;
var hdmiSeen = {};

var prevNet = null;
var TEMP_HISTORY_MAX = 120;
var tempHistory = [];
var bootEpoch = 0;

var lastStats = null;
var lastStatsTime = 0;
var isCollecting = false;
var statsWaiters = [];

var EOL_MAP = { 1: 'Normal', 2: 'Warning', 3: 'Urgent' };
var EMMC_CACHE = null;
var SWAP_BACKING_CACHE = null;
var MAC_CACHE = {};
var cachedRemote = null;
var lastRemoteCheck = 0;
var cachedAppStorage = null;
var lastAppStorageCheck = 0;
var APP_STORAGE_TTL = 60000;
var CPU_WINDOW_MS = 700;

var lastPicModes = [];
var inputNameMap = {};
var lastInputScan = 0;
var installedApps = [];
// Every app's title by id, hidden ones included: the app list leaves out apps
// hidden from the home screen, but one can still be the app on screen.
var appTitles = {};
var lastAppsScan = 0;

var SOC_ARCH = {
  O22: 'Alpha 9 Gen 5 (O22)',
  O20: 'Alpha 9 Gen 3 (O20)',
  O18: 'Alpha 9 Gen 1 (O18)',
  M16P: 'Alpha 7 (M16P)',
  M16PLUS: 'Alpha 7 (M16P)'
};

var PIC_MODE_MAP = ha.PIC_MODE_MAP;

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  lunaCachedFn = opts.lunaCached;
  configObj = opts.config;
  oledModule = opts.oled;
  privacyModule = opts.privacy;
  screensaversModule = opts.screensavers;
  tvwebVersionStr = opts.tvwebVersion || '0.0.0';
  mapPowerStateFn = opts.mapPowerState;
  isScreenSaverFn = opts.isScreenSaver;
}

function rd(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch (e) { return null; }
}

function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

function meminfo() {
  var out = {}, raw = rd('/proc/meminfo');
  if (!raw) return out;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

function emmcInfo() {
  if (EMMC_CACHE) return EMMC_CACHE;
  var raw = rd('/sys/block/mmcblk0/device/life_time');
  var eolRaw = rd('/sys/block/mmcblk0/device/pre_eol_info');
  var eol = EOL_MAP[parseInt(eolRaw, 16)] || 'unknown';
  if (!raw) {
    EMMC_CACHE = { life: 'unknown', wear: 'unknown', health: 'unknown', eol: eol };
    return EMMC_CACHE;
  }

  var parts = raw.split(/\s+/), wearList = [], minHealth = 100;
  for (var i = 0; i < parts.length; i++) {
    var n = parseInt(parts[i], 16);
    if (!n) continue;
    if (n >= 11) {
      wearList.push('>100%');
      minHealth = 0;
    } else {
      wearList.push(((n - 1) * 10) + '-' + (n * 10) + '%');
      var rem = 100 - (n * 10);
      if (rem < minHealth) minHealth = rem;
    }
  }

  var uniqWear = [];
  for (var u = 0; u < wearList.length; u++) {
    if (uniqWear.indexOf(wearList[u]) === -1) uniqWear.push(wearList[u]);
  }
  var wearStr = uniqWear.length ? uniqWear.join(' / ') : '0-10%';
  var healthStr = (minHealth >= 90) ? '>90% (Healthy)' : (minHealth + '% remaining');
  EMMC_CACHE = {
    life: wearStr,
    wear: wearStr,
    health: healthStr,
    eol: eol
  };
  return EMMC_CACHE;
}

function socTemp() {
  if (!THERMAL_SOURCE) return null;
  var t = num(rd(THERMAL_SOURCE), null);
  if (t !== null && THERMAL_SOURCE === SYS_THERMAL) t = Math.round(t / 1000);
  return (t !== null && t > 0) ? t : null;
}

// Per-core load from /proc/stat, for models whose /proc/lg/pm/status has no
// load line. Each call measures since the previous one, so the first is empty.
// Offline cores drop out of /proc/stat, so only cores in both samples count.
var prevCoreTicks = null;
function statCoreLoads() {
  var now = {};
  var lines = (rd('/proc/stat') || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^cpu(\d+)\s+(.*)$/);
    if (!m) continue;
    var f = m[2].trim().split(/\s+/).map(Number), total = 0;
    for (var j = 0; j < f.length; j++) total += f[j] || 0;
    now[m[1]] = { total: total, idle: (f[3] || 0) + (f[4] || 0) };
  }
  var prev = prevCoreTicks, loads = [];
  prevCoreTicks = now;
  if (!prev) return loads;
  Object.keys(now).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (c) {
    if (!prev[c]) return;
    var dt = now[c].total - prev[c].total, di = now[c].idle - prev[c].idle;
    if (dt > 0) loads.push(Math.max(0, Math.min(100, Math.round(100 * (dt - di) / dt))));
  });
  return loads;
}

function onlineCpus(status) {
  var raw = rd('/sys/devices/system/cpu/online');
  if (raw) {
    var idx = [], parts = raw.trim().split(',');
    for (var i = 0; i < parts.length; i++) {
      var range = parts[i].split('-');
      var lo = parseInt(range[0], 10);
      var hi = range.length > 1 ? parseInt(range[1], 10) : lo;
      if (isNaN(lo) || isNaN(hi)) continue;
      for (var c = lo; c <= hi; c++) idx.push(c);
    }
    if (idx.length) return idx;
  }
  var m = (status || '').match(/cpu_num:\s*(\d+)/);
  if (!m) return null;
  var n = parseInt(m[1], 10), out = [];
  for (var k = 0; k < n; k++) out.push(k);
  return out;
}

function socMhz() {
  var v = num(rd('/proc/lg/pm/frequency'), 0);
  if (!v || v < 0) return null;
  var mhz = Math.round(v > 10000 ? v / 1000 : v);
  return (mhz >= 100 && mhz <= 10000) ? mhz : null;
}

function swapBacking() {
  if (SWAP_BACKING_CACHE !== null) return SWAP_BACKING_CACHE;
  var raw = rd('/proc/swaps');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null, bestSize = -1;
  for (var i = 1; i < lines.length; i++) {
    var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
    if (f.length < 3 || !f[0]) continue;
    var size = parseInt(f[2], 10);
    if (isNaN(size) || size <= bestSize) continue;
    bestSize = size;
    best = /zram/i.test(f[0]) ? 'zram' : (f[1] === 'file' ? 'file' : 'flash');
  }
  SWAP_BACKING_CACHE = best;
  return best;
}

function wifi() {
  var raw = rd('/proc/net/wireless');
  if (!raw) return null;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('wlan0') !== -1) {
      var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
      var link = parseFloat(f[2]), level = parseFloat(f[3]);
      if (!link && !level) return null;
      if (level > 127) level = level - 256;
      return { link: link, level: level };
    }
  }
  return null;
}

function ifaceRank(name) {
  var st = rd('/sys/class/net/' + name + '/operstate');
  if (st) {
    st = st.trim();
    if (st === 'up') return 2;
    if (st === 'down') return 0;
    return 1;
  }
  var car = rd('/sys/class/net/' + name + '/carrier');
  if (!car) return 1;
  return car.trim() === '1' ? 2 : 0;
}

function macAddress(iface) {
  if (!iface) return null;
  if (MAC_CACHE[iface]) return MAC_CACHE[iface];
  var raw = rd('/sys/class/net/' + iface + '/address');
  if (!raw) return null;
  var mac = raw.trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  if (mac === '00:00:00:00:00:00') return null;
  MAC_CACHE[iface] = mac;
  return mac;
}

function netBytes() {
  var raw = rd('/proc/net/dev');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null;
  for (var i = 0; i < lines.length; i++) {
    var idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    var name = lines[i].slice(0, idx).replace(/\s+/g, '');
    if (!name || name === 'lo') continue;
    var f = lines[i].slice(idx + 1).replace(/\s+/g, ' ').trim().split(' ');
    var rx = parseInt(f[0], 10), tx = parseInt(f[8], 10);
    if (isNaN(rx) || isNaN(tx)) continue;
    var rank = ifaceRank(name);
    if (!best || rank > best.rank || (rank === best.rank && rx > best.rx)) {
      best = { iface: name, rank: rank, rx: rx, tx: tx, t: Date.now() };
    }
  }
  return best;
}

function getVideoSignal() {
  for (var p = 0; p < 4; p++) {
    var raw = rd('/proc/lg/hdmi20/port' + p + '/status');
    if (!raw) continue;
    var isConn = /connected:\s*on/i.test(raw) || /PHY\s+Lock\[1\]/i.test(raw);
    var w = null, h = null, hz = '';
    var wMatch = raw.match(/horizontal-active:\s*(\d+)/);
    var hMatch = raw.match(/vertical-active:\s*(\d+)/);
    var hzMatch = raw.match(/pixel-clock-V:\s*(\d+)\s*Hz/);
    if (wMatch && hMatch) {
      w = wMatch[1];
      h = hMatch[1];
      if (hzMatch) hz = ' @ ' + hzMatch[1] + 'Hz';
    } else {
      var sigM = raw.match(/Sig:\s*\[(\d+)\](?:\(\d+\))?x\[(\d+)\](?:\(\d+\))?@\[(\d+)\]\s*Hz/i);
      if (sigM && parseInt(sigM[1], 10) > 0) {
        w = sigM[1];
        h = sigM[2];
        hz = ' @ ' + sigM[3] + 'Hz';
        isConn = true;
      }
    }
    if (isConn) {
      if (w && h) return w + 'x' + h + hz;
      return 'Connected';
    }
  }
  return null;
}

function readRemoteInfo() {
  var now = Date.now();
  if (cachedRemote && (now - lastRemoteCheck < 30000)) return cachedRemote;
  var raw = rd('/mnt/lg/cmn_data/mrcu/mrcu1.info');
  if (!raw) return cachedRemote || null;
  var bMatch = raw.match(/Battery\s*=\s*(\d+)/i);
  var nMatch = raw.match(/Name\s*=\s*([^\r\n]+)/i);
  var macMatch = raw.match(/BDAddr\s*=\s*([^\r\n]+)/i);
  var fwMatch = raw.match(/fwVer\s*=\s*([^\r\n]+)/i);
  if (!bMatch && !nMatch) return cachedRemote || null;
  cachedRemote = {
    battery: bMatch ? parseInt(bMatch[1], 10) : null,
    model: nMatch ? nMatch[1].trim() : null,
    mac: macMatch ? macMatch[1].trim() : null,
    firmware: fwMatch ? fwMatch[1].trim() : null,
    paired: true
  };
  lastRemoteCheck = Date.now();
  return cachedRemote;
}

function getActiveHdmiDiagnostics() {
  for (var p = 0; p < 4; p++) {
    var raw = rd('/proc/lg/hdmi20/port' + p + '/status');
    if (!raw) continue;
    var isConn = /connected:\s*on/i.test(raw) || /PHY\s+Lock\[1\]/i.test(raw) || /is5Vconnected\[1\]/i.test(raw);
    if (!isConn) continue;

    var phyMatch = raw.match(/PHY Mode\[([^\]]+)\]/i);
    var fmtMatch = raw.match(/Video Format\[([^\]]+)\]/i);
    var hdcpMatch = raw.match(/Current HDCP Auth Version => (HDCP\w+)/i);
    var errMatch = raw.match(/PHY Error Count\s*:\s*(\d+)/i);
    var allmMatch = raw.match(/isAllm\[(\d+)\]/i);
    var vrrMatch = raw.match(/isFreeSync\[(\d+)\]/i);
    var vrrMinMax = raw.match(/VRR Min\[(\d+)\]\/Max\[(\d+)\]/i);
    var qmsMatch = raw.match(/QMSMode\[(\d+)\]/i);

    var phyMode = null;
    if (phyMatch) {
      var rawPhy = phyMatch[1].trim();
      if (/FRL 12G 4L/i.test(rawPhy)) phyMode = 'FRL 48 Gbps';
      else if (/FRL 10G 4L/i.test(rawPhy)) phyMode = 'FRL 40 Gbps';
      else if (/FRL 8G 4L/i.test(rawPhy)) phyMode = 'FRL 32 Gbps';
      else if (/FRL 6G 4L/i.test(rawPhy)) phyMode = 'FRL 24 Gbps';
      else if (/FRL 6G 3L/i.test(rawPhy)) phyMode = 'FRL 18 Gbps';
      else if (/FRL 3G 3L/i.test(rawPhy)) phyMode = 'FRL 9 Gbps';
      else if (/3G/i.test(rawPhy)) phyMode = 'TMDS (3G)';
      else if (/6G/i.test(rawPhy)) phyMode = 'TMDS (6G)';
      else phyMode = rawPhy;
    }

    var format = null;
    if (fmtMatch) {
      var rawFmt = fmtMatch[1].trim();
      if (rawFmt === 'R444') format = 'RGB 4:4:4';
      else if (rawFmt === 'Y444') format = 'YCbCr 4:4:4';
      else if (rawFmt === 'Y422') format = 'YCbCr 4:2:2';
      else if (rawFmt === 'Y420') format = 'YCbCr 4:2:0';
      else format = rawFmt;
    }

    var hdcp = null;
    if (hdcpMatch) {
      var rawHdcp = hdcpMatch[1].trim();
      if (rawHdcp === 'HDCP23') hdcp = 'HDCP 2.3';
      else if (rawHdcp === 'HDCP22') hdcp = 'HDCP 2.2';
      else if (rawHdcp === 'HDCP14') hdcp = 'HDCP 1.4';
      else if (rawHdcp === 'HDCP0') hdcp = 'None';
      else hdcp = rawHdcp;
    }

    var isVrr = (vrrMatch && vrrMatch[1] === '1') ||
                (vrrMinMax && (parseInt(vrrMinMax[1], 10) > 0 || parseInt(vrrMinMax[2], 10) > 0));

    return {
      port: p,
      phy_mode: phyMode,
      chroma: format,
      hdcp: hdcp,
      phy_errors: errMatch ? parseInt(errMatch[1], 10) : null,
      allm: allmMatch ? (allmMatch[1] === '1') : null,
      vrr: (vrrMatch || vrrMinMax) ? !!isVrr : null,
      qms: qmsMatch ? (qmsMatch[1] === '1') : null
    };
  }
  return null;
}

function getPictureEngineInfo() {
  var raw = rd('/proc/lg/pe/hdr_status');
  if (!raw) return null;
  var colMatch = raw.match(/colorimetry:\s*([^,\}]+)/i);
  var hdrMatch = raw.match(/hdrStatus:\s*([^\(,\}]+)/i);
  var peakMatch = raw.match(/peakLuminance:\s*(\d+)/i);

  var colorimetry = null;
  if (colMatch) {
    var rawCol = colMatch[1].trim().toLowerCase();
    if (rawCol === 'bt709') colorimetry = 'BT.709';
    else if (rawCol === 'bt2020') colorimetry = 'BT.2020';
    else if (rawCol === 'bt601') colorimetry = 'BT.601';
    else colorimetry = colMatch[1].trim();
  }

  return {
    colorimetry: colorimetry,
    hdr_mode: hdrMatch ? hdrMatch[1].trim() : null,
    peak_luminance: peakMatch ? parseInt(peakMatch[1], 10) : null
  };
}

function formatSoundOutput(so) {
  if (!so) return 'TV Speaker';
  return SOUND_OUTPUT_MAP[so] || so;
}

function formatPicMode(mode) {
  if (!mode) return 'Standard';
  return PIC_MODE_MAP[mode] || mode;
}

/*
 * The picture setting's "dimension". LG's own picture settings code (webOS 9.2,
 * QuickSettings PictureModeInterfaces) knows sdr, hdr, dolbyHdr and
 * technicolorHdr, each of the three HDR kinds also with an ALLM suffix: the
 * source asked for Auto Low Latency Mode, the TV's game-style low-latency
 * picture. Anything else is shown readably rather than as one word in capitals.
 */
var DYNAMIC_RANGES = { sdr: 'SDR', hdr: 'HDR', dolbyHdr: 'Dolby Vision', technicolorHdr: 'Technicolor HDR' };

function formatDynamicRange(dr) {
  if (!dr) return 'SDR';
  var s = String(dr), low = /ALLM$/.test(s);
  if (low) s = s.slice(0, -4);
  var name = DYNAMIC_RANGES[s] ||
    s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^(sdr|hdr|hlg)/i, function (m) { return m.toUpperCase(); })
     .replace(/^./, function (c) { return c.toUpperCase(); });
  return low ? name + ' \u00b7 Low latency' : name;
}

function pictureModes(cb) {
  if (!lunaCachedFn) return cb([]);
  lunaCachedFn('com.webos.service.settings/getSystemSettingValues',
    { category: 'picture', key: 'pictureMode' }, 10000, function (res) {
      var arr = (res && res.values && res.values.arrayExt) || [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].visible === true && arr[i].active !== false) {
          out.push({ value: arr[i].value, label: formatPicMode(arr[i].value) });
        }
      }
      if (out.length) lastPicModes = out;
      cb(out);
    });
}

function refreshInputNames(cb) {
  if (Date.now() - lastInputScan < 60000 && Object.keys(inputNameMap).length > 0) {
    if (cb) cb(inputNameMap);
    return;
  }
  if (!lunaFn) {
    if (cb) cb(inputNameMap);
    return;
  }
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    if (res && res.devices && res.devices.length) {
      for (var i = 0; i < res.devices.length; i++) {
        var d = res.devices[i];
        if (d.appId && d.label) {
          var shortId = String(d.appId).replace('com.webos.app.', '');
          inputNameMap[shortId] = d.label;
        }
      }
      lastInputScan = Date.now();
    }
    if (cb) cb(inputNameMap);
  });
}

function parseAppList(raw) {
  var list = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var a = raw[i];
    if (a && a.id && a.title) appTitles[a.id] = a.title;
    if (a && a.id && a.visible !== false && a.id.indexOf('com.webos.app.container') !== 0) {
      if (!seen[a.id]) {
        seen[a.id] = true;
        list.push({
          id: a.id,
          title: a.title || a.id
        });
      }
    }
  }
  list.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
  return list;
}

function refreshInstalledApps(cb) {
  var now = Date.now();
  if (installedApps.length > 0 && (now - lastAppsScan < 300000)) {
    if (cb) cb(installedApps);
    return;
  }
  if (!lunaFn) {
    if (cb) cb(installedApps);
    return;
  }
  lunaFn('com.webos.applicationManager/listApps', {}, function (res) {
    var raw = (res && (res.launchPoints || res.apps)) || null;
    if (Array.isArray(raw) && raw.length > 0) {
      installedApps = parseAppList(raw);
      lastAppsScan = Date.now();
      if (cb) cb(installedApps);
      return;
    }
    lunaFn('com.webos.applicationManager/listLaunchPoints', {}, function (lp) {
      var rawLp = (lp && (lp.launchPoints || lp.apps)) || null;
      if (Array.isArray(rawLp)) {
        installedApps = parseAppList(rawLp);
        lastAppsScan = Date.now();
      }
      if (cb) cb(installedApps);
    });
  });
}

function gpuClockMhz() {
  var raw = rd('/proc/lg/sys/status');
  if (!raw) return null;
  var m = raw.match(/gpu pll out\s*:\s*(\d+)/i);
  return m ? Math.round(parseInt(m[1], 10) / 1000000) : null;
}

function appStorage(cb) {
  var now = Date.now();
  if (cachedAppStorage && (now - lastAppStorageCheck < APP_STORAGE_TTL)) {
    return cb(cachedAppStorage);
  }
  execFile('/bin/df', ['-k', '/mnt/lg/appstore'], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(cachedAppStorage || null);
    var lines = String(stdout || '').trim().split('\n');
    var f = (lines[lines.length - 1] || '').split(/\s+/);
    if (f.length < 4) return cb(cachedAppStorage || null);
    var total = parseInt(f[1], 10), used = parseInt(f[2], 10), avail = parseInt(f[3], 10);
    if (!total) return cb(cachedAppStorage || null);
    cachedAppStorage = {
      totalMb: Math.round(total / 1024),
      usedMb: Math.round(used / 1024),
      freeMb: Math.round(avail / 1024),
      pct: Math.round(used / total * 100)
    };
    lastAppStorageCheck = Date.now();
    cb(cachedAppStorage);
  });
}

function hdmiPorts() {
  var ports = [];
  for (var i = 0; i < 4; i++) {
    var raw = rd('/proc/lg/hdmi20/port' + i + '/status');
    if (!raw) continue;
    function f(re) { var m = raw.match(re); return m ? m[1].trim() : null; }
    var hact = parseInt(f(/horizontal-active:\s*(\d+)/) || '0', 10);
    var vact = parseInt(f(/vertical-active:\s*(\d+)/) || '0', 10);
    var rate = parseInt(f(/pixel-clock-V:\s*(\d+)/) || '0', 10);
    var pclk = parseInt(f(/pixel-clock:\s*(\d+)/) || '0', 10);

    if (!hact || !vact) {
      var sigM = raw.match(/Sig:\s*\[(\d+)\](?:\(\d+\))?x\[(\d+)\](?:\(\d+\))?@\[(\d+)\]\s*Hz/i);
      if (sigM) {
        hact = parseInt(sigM[1], 10);
        vact = parseInt(sigM[2], 10);
        if (!rate) rate = parseInt(sigM[3], 10);
      }
    }
    if (!pclk) {
      var pclkStr = f(/Pixel Clk\[0*([1-9]\d*)\]/i);
      if (pclkStr) {
        var pclkNum = parseInt(pclkStr, 10);
        pclk = (pclkNum < 100000) ? pclkNum * 10 : Math.round(pclkNum / 1000);
      }
    }
    var isConnected = /connected:\s*on/i.test(raw) ||
                      /PHY\s+Lock\[1\]/i.test(raw) ||
                      (hact > 0 && vact > 0);
    var colorDepth = f(/deep-color-mode:\s*(\S+ \S+)/) || f(/DeepColorMode\[\s*([^\]]+)\]/);
    if (colorDepth) colorDepth = colorDepth.replace(/^[.\s]+/, '');
    var isInterlaced = /interlaced:\s*yes/i.test(raw) || /Interlaced\[1\]/i.test(raw);

    ports.push({
      port: i,
      connected: isConnected,
      resolution: (isConnected && hact && vact) ? (hact + 'x' + vact) : null,
      refreshHz: (isConnected && rate) ? rate : null,
      pixelClockMhz: (isConnected && pclk) ? Math.round(pclk / 1000 * 10) / 10 : null,
      colorDepth: isConnected ? colorDepth : null,
      interlaced: isConnected ? isInterlaced : false
    });
  }
  return ports;
}

function hdmiInputs(cb) {
  if (!lunaFn) return cb({ ok: false, error: 'luna bus not available' });
  lunaFn('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    var devs = (res && res.devices) || [];
    var ports = hdmiPorts();
    var signalling = [];
    for (var p = 0; p < ports.length; p++) if (ports[p].connected) signalling.push(ports[p]);

    var inputs = [];
    var activeIdx = -1;
    for (var d = 0; d < devs.length; d++) {
      if (!devs[d].id || String(devs[d].id).indexOf('HDMI') !== 0) continue;
      if (devs[d].activate) activeIdx = inputs.length;
      var hasCec = devs[d].lastUniqueId !== undefined &&
                   devs[d].lastUniqueId !== 255 &&
                   devs[d].lastUniqueId !== -1;
      var seen = !!(hasCec || devs[d].hdmiPlugIn || devs[d].connected || (devs[d].subCount > 0));
      inputs.push({
        id: devs[d].id,
        port: devs[d].port,
        label: devs[d].label || devs[d].id,
        appId: devs[d].appId,
        active: !!devs[d].activate,
        deviceSeen: seen,
        signal: null
      });
    }
    if (activeIdx !== -1 && signalling.length === 1) {
      inputs[activeIdx].signal = signalling[0];
    }
    cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: (activeIdx !== -1 && signalling.length === 1) });
  });
}

function procName(comm, args) {
  var bin = String(args).split(/\s+/)[0].replace(/^.*\//, '');

  if (bin === 'WebAppMgr') {
    var app = args.match(/\/usr\/palm\/applications\/([^\/\s]+)/);
    if (app) return 'WebAppMgr (' + app[1].replace(/^com\.webos\.app\./, '') + ')';
    var type = args.match(/--type=(\w+)/);
    return 'WebAppMgr (' + (type ? type[1] : 'browser') + ')';
  }

  return (comm && comm.length < 15) ? comm : (bin || comm);
}

function sampleCpuTicks() {
  var out = { total: 0, procs: {} };
  try {
    var cpu = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    for (var i = 1; i < cpu.length; i++) out.total += parseInt(cpu[i], 10) || 0;
  } catch (e) {
    return null;
  }
  var names;
  try { names = fs.readdirSync('/proc'); } catch (e2) { return null; }
  for (var n = 0; n < names.length; n++) {
    if (!/^\d+$/.test(names[n])) continue;
    try {
      var raw = fs.readFileSync('/proc/' + names[n] + '/stat', 'utf8');
      var close = raw.lastIndexOf(')');
      if (close < 0) continue;
      var f = raw.slice(close + 2).split(' ');
      out.procs[names[n]] = {
        ticks: (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0),
        comm: raw.slice(raw.indexOf('(') + 1, close)
      };
    } catch (e3) {}
  }
  return out;
}

function procCmdline(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')
             .replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch (e) {
    return '';
  }
}

function collectCpuProcesses(cb, retried) {
  var first = sampleCpuTicks();
  if (!first) return cb({ ok: false, error: 'could not read /proc' });

  setTimeout(function () {
    var second = sampleCpuTicks();
    if (!second) return cb({ ok: false, error: 'could not read /proc' });

    var elapsed = second.total - first.total;
    if (elapsed <= 0) {
      if (retried) return cb({ ok: false, error: 'the CPU counters did not move' });
      return collectCpuProcesses(cb, true);
    }

    var rows = [], busy = 0;
    for (var pid in second.procs) {
      if (!second.procs.hasOwnProperty(pid)) continue;
      var was = first.procs[pid];
      if (!was) continue;
      var delta = second.procs[pid].ticks - was.ticks;
      if (delta <= 0) continue;
      var pct = delta / elapsed * 100;
      busy += pct;
      rows.push({ name: procName(second.procs[pid].comm, procCmdline(pid)), pct: Math.round(pct * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.pct - a.pct; });
    cb({
      ok: true,
      windowMs: CPU_WINDOW_MS,
      busy: Math.round(busy * 10) / 10,
      active: rows.length,
      top: rows.slice(0, 10)
    });
  }, CPU_WINDOW_MS);
}

function collectProcesses(cb) {
  execFile('/bin/ps', ['-eo', 'rss,comm,args'], { timeout: 4000, maxBuffer: 1024 * 1024 }, function (err, stdout) {
    if (err) return cb({ ok: false, error: 'could not read process list' });
    var lines = String(stdout || '').split('\n'), rows = [], total = 0, count = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/);
      if (!m) continue;
      var rss = parseInt(m[1], 10);
      count++;
      total += rss;
      rows.push({ name: procName(m[2], m[3]), mb: Math.round(rss / 1024 * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.mb - a.mb; });
    cb({
      ok: true,
      count: count,
      totalMb: Math.round(total / 1024),
      top: rows.slice(0, 10)
    });
  });
}

function socArchName(raw) {
  if (!raw) return null;
  var key = String(raw).replace(/^_+|_+$/g, '').toUpperCase();
  if (!key) return null;
  return SOC_ARCH[key] || key;
}

function detectWebosVersion(sdkVersion) {
  var raw = rd('/etc/issue') || rd('/etc/issue.net') || '';
  var m = raw.match(/webOS(?:\s+TV)?\s+([\d\.]+)/i);
  if (m) return m[1];
  var sf = rd('/etc/starfish-release') || '';
  var sm = sf.match(/release\s+([\d\.]+)/i);
  if (sm) return sm[1];
  if (sdkVersion) return String(sdkVersion);
  return null;
}

function detectHardwareInfo(sdkVersion, cb) {
  HARDWARE_INFO.webos = detectWebosVersion(sdkVersion);
  var envRaw = rd('/var/luna/preferences/environmentCondition');
  if (envRaw) {
    try {
      var env = JSON.parse(envRaw);
      var bStr = env.boardTypeStr || env.socChip || rd('/proc/lg/base/chip_name') || '';
      if (bStr) {
        bStr = bStr.trim();
        HARDWARE_INFO.socArch = socArchName(bStr);
      }
      if (env.ddrSize) HARDWARE_INFO.ram = env.ddrSize;
      if (env.panelOutputFrameRate) HARDWARE_INFO.refreshRate = env.panelOutputFrameRate + ' Hz';
      if (env.digitalEyeMode) HARDWARE_INFO.eyeSensor = env.digitalEyeMode;
      else if (env.isDigitalEye === 'true') HARDWARE_INFO.eyeSensor = 'Digital Eye';
    } catch (e) {}
  }
  if (!HARDWARE_INFO.socArch) {
    var chip = rd('/proc/lg/base/chip_name');
    if (chip) HARDWARE_INFO.socArch = socArchName(chip.trim());
  }

  if (!lunaFn) {
    if (cb) cb();
    return;
  }

  lunaFn('com.webos.service.panelcontroller/getOledCellInfo', {}, function (cellRes) {
    if (cellRes && cellRes.cellInfo) HARDWARE_INFO.cell = cellRes.cellInfo;
    lunaFn('com.webos.service.panelcontroller/getOledTconInfo', {}, function (tconRes) {
      if (tconRes && tconRes.tconParamForInstart) {
        HARDWARE_INFO.tconFirmware = tconRes.tconParamForInstart.tconFpgaFirmwareVer || null;
        HARDWARE_INFO.tconModule = tconRes.tconParamForInstart.tconModuleInfo || null;
      }
      if (cb) cb();
    });
  });
}

function detectDeviceInfo(cb) {
  if (!lunaFn) {
    if (cb) cb();
    return;
  }
  lunaFn('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'] },
    function (res) {
      if (configObj && configObj.device) {
        if (res && res.modelName) {
          if (!configObj.device.model || configObj.device.model === 'OLED65B8SLC' || configObj.device.model === 'webOS TV') {
            configObj.device.model = res.modelName;
          }
          if (!configObj.device.name || configObj.device.name === 'LG webOS TV' || configObj.device.name === 'LG OLED B8 TV') {
            configObj.device.name = 'LG ' + res.modelName;
          }
          if (res.firmwareVersion) {
            configObj.device.sw_version = res.firmwareVersion;
          }
          console.log('device detected: ' + (configObj.device.name || 'LG TV') + ' (model: ' + configObj.device.model + ') fw: ' + (res.firmwareVersion || '?'));
        }
        if (!configObj.device.name) configObj.device.name = 'LG webOS TV';
        if (!configObj.device.model) configObj.device.model = 'webOS TV';
      }
      detectHardwareInfo((res && res.sdkVersion) || null, function () {
        if (cb) cb();
      });
    }
  );
}

function detectFrontLights(cb) {
  if (hasLogoLight !== null) return cb(hasLogoLight);
  if (!lunaFn) return cb(false);
  lunaFn('com.webos.service.tv.systemproperty/getSystemProperties',
       { keys: ['tv.model.logoLight'] }, function (res) {
    var v = res && res['tv.model.logoLight'];
    hasLogoLight = (v === true);
    console.log('front lights: standby LED' + (hasLogoLight ? ' + logo light' : ' only (no logo light on this model)'));
    cb(hasLogoLight);
  });
}

// LG stores the hour and minute as separate strings, "1" and "0" for 01:00.
function clockTime(h, m) {
  function two(v) { v = parseInt(v, 10) || 0; return (v < 10 ? '0' : '') + v; }
  return two(h) + ':' + two(m);
}

function pushTemp(t) {
  if (typeof t !== 'number' || isNaN(t) || t <= 0) return;
  tempHistory.push(t);
  if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
}

function bootTime(uptimeSec) {
  var computed = Date.now() - uptimeSec * 1000;
  if (Math.abs(computed - bootEpoch) > 30000) bootEpoch = computed;
  return new Date(bootEpoch).toISOString();
}

function clearCache() {
  lastStats = null;
  lastAppsScan = 0;
}

function collectStats(cb) {
  var now = Date.now();
  if (lastStats && (now - lastStatsTime < 1500)) {
    return cb(lastStats);
  }

  statsWaiters.push(cb);
  if (isCollecting) return;
  isCollecting = true;

  var safetyTimeout = setTimeout(function () {
    if (isCollecting) {
      console.log('warning: stats collection safety timeout reached');
      flushStats(lastStats || { ok: false, error: 'timeout' });
    }
  }, 4500);

  function flushStats(result) {
    clearTimeout(safetyTimeout);
    lastStats = result;
    lastStatsTime = Date.now();
    isCollecting = false;
    var waiters = statsWaiters.slice(0);
    statsWaiters = [];
    for (var w = 0; w < waiters.length; w++) {
      try { waiters[w](result); } catch (e) {}
    }
  }

  var mi = meminfo();
  var status = rd('/proc/lg/pm/status') || '';
  var coreMatch = status.match(/load:\s*([\d\s]+)/);
  var coreSlots = coreMatch ? coreMatch[1].trim().split(/\s+/).map(Number) : [];
  var liveCpus = onlineCpus(status);
  var coreLoads = [];
  if (!coreSlots.length) {
    coreLoads = statCoreLoads();
    coreSlots = coreLoads;
  } else if (liveCpus) {
    for (var ci = 0; ci < liveCpus.length; ci++) {
      if (liveCpus[ci] < coreSlots.length) coreLoads.push(coreSlots[liveCpus[ci]]);
    }
  } else {
    coreLoads = coreSlots;
  }
  var cpuAvsMatch = status.match(/cpuavs_current\(mA\):\s*(\d+)/);
  var coreAvsMatch = status.match(/coreavs_current\(mA\):\s*(\d+)/);
  var cpuMa = cpuAvsMatch ? parseInt(cpuAvsMatch[1], 10) : null;
  var coreMa = coreAvsMatch ? parseInt(coreAvsMatch[1], 10) : null;
  var totalMa = (cpuMa !== null && coreMa !== null) ? (cpuMa + coreMa) : null;

  var n = netBytes();
  var rate = null;
  if (n && prevNet && n.iface === prevNet.iface && n.t > prevNet.t && n.rx >= prevNet.rx) {
    var dt = (n.t - prevNet.t) / 1000;
    rate = { rx: Math.round((n.rx - prevNet.rx) / dt), tx: Math.round((n.tx - prevNet.tx) / dt) };
  }
  if (n) prevNet = n;

  var hdmiDiag = getActiveHdmiDiagnostics();
  if (hdmiDiag) {
    for (var hf in hdmiDiag) {
      if (hf !== 'port' && hdmiDiag[hf] !== null) hdmiSeen[hf] = true;
    }
  }
  var peInfo = getPictureEngineInfo();
  var uptimeSec = Math.floor(parseFloat(rd('/proc/uptime') || '0'));

  var devCfg = (configObj && configObj.device) || {};
  var out = {
    ok: true,
    time: Date.now(),
    tvwebVersion: tvwebVersionStr,
    device: {
      id: devCfg.id || 'lg_tv',
      name: devCfg.name || 'LG webOS TV',
      model: devCfg.model || 'webOS TV'
    },
    system: {
      webos: HARDWARE_INFO.webos,
      firmware: devCfg.sw_version || null
    },
    hardware: {
      webos: HARDWARE_INFO.webos,
      soc_arch: HARDWARE_INFO.socArch,
      ram: HARDWARE_INFO.ram,
      refresh_rate: HARDWARE_INFO.refreshRate,
      eye_sensor: HARDWARE_INFO.eyeSensor
    },
    panel_silicon: HARDWARE_INFO.cell ? {
      cell: HARDWARE_INFO.cell,
      tcon_firmware: HARDWARE_INFO.tconFirmware,
      tcon_module: HARDWARE_INFO.tconModule
    } : null,
    remote: readRemoteInfo(),
    temp: socTemp(),
    temps: null,
    load: coreLoads.length
      ? Math.round(coreLoads.reduce(function (a, b) { return a + b; }, 0) / coreLoads.length)
      : num(rd('/proc/lg/pm/current_load'), null),
    loadPeak: coreLoads.length
      ? Math.max.apply(null, coreLoads)
      : num(rd('/proc/lg/pm/current_load'), null),
    mhz: socMhz(),
    cores: coreLoads,
    coresTotal: coreSlots.length,
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    swap: { total: mi.SwapTotal || 0, free: mi.SwapFree || 0, backing: swapBacking() },
    uptime: uptimeSec,
    bootTime: bootTime(uptimeSec),
    loadavg: (rd('/proc/loadavg') || '').split(' ').slice(0, 3),
    wifi: wifi(),
    net: rate,
    netTotal: n ? { rx: n.rx, tx: n.tx, iface: n.iface } : null,
    mac: n ? macAddress(n.iface) : null,
    emmc: emmcInfo(),
    signal: getVideoSignal(),
    hdmi_diag: hdmiDiag,
    picture_engine: peInfo,
    colorimetry: peInfo ? peInfo.colorimetry : null,
    power: {
      cpu_ma: cpuMa,
      core_ma: coreMa,
      current_ma: totalMa
    },
    inputs: inputNameMap
  };

  pushTemp(out.temp);
  out.temps = tempHistory.slice();

  refreshInputNames();

  if (!lunaFn || !lunaCachedFn) {
    return flushStats(out);
  }

  lunaFn('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    var rawPower = pw ? (pw.state || pw.processing) : null;
    out.powerState = mapPowerStateFn ? mapPowerStateFn(rawPower) : null;
    out.screenSaver = isScreenSaverFn ? isScreenSaverFn(out.powerState) : false;
    out.screensaverMode = screensaversModule ? screensaversModule.screensaverMode() : 'stock';
    out.screensaverLevel = screensaversModule ? screensaversModule.screensaverLevel() : 'dim';

  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'time', keys: ['sleepTimer'] }, 30000, function (tm) {
    out.sleepTimer = (tm && tm.settings && tm.settings.sleepTimer) || 'off';

  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'option', keys: ['standByLight', 'logoLight', 'powerOnLight', 'quickStartMode'] }, 60000, function (op) {
    var os = (op && op.settings) || {};
    out.lights = {
      standby: os.standByLight === 'on',
      logo: os.logoLight === 'on',
      powerOn: os.powerOnLight === 'on',
      hasLogo: hasLogoLight === true
    };
    if (os.quickStartMode !== undefined) {
      out.quickBoot = os.quickStartMode === 'on';
    }
    out.gpuMhz = gpuClockMhz();

  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'network', keys: ['wolwowlOnOff'] }, 60000, function (nw) {
    var wol = nw && nw.settings && nw.settings.wolwowlOnOff;
    if (wol !== undefined) out.wakeOnLan = wol === true || wol === 'true';

  // A C2 on webOS 9.2 has this key and a B8 on 4.4 does not, so the switch is
  // offered only where the TV reports one.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'other', keys: ['lgLogoDisplay'] }, 60000, function (ot) {
    var logo = ot && ot.settings && ot.settings.lgLogoDisplay;
    if (logo !== undefined) out.lgLogo = logo === 'on' || logo === true;

  /*
   * LG's device detection (UEI QuickSet), which finds a set-top box and smart
   * lights, plugs and switches for the Home Dashboard. On a C2 (webOS 9.2) its
   * iconnectivity service reverse-looks-up every address on the local network,
   * three times over, each time the TV switches on: 759 lookups in two
   * minutes, and none with this off. Asked on its own so a TV without it does
   * not lose the rest.
   */
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'other', keys: ['ueiEnable'] }, 60000, function (ue) {
    var uei = ue && ue.returnValue !== false && ue.settings && ue.settings.ueiEnable;
    if (uei !== undefined && uei !== null && uei !== false) out.deviceDetection = uei === 'on' || uei === true;

  // LG's Always-on: holds the TV in Active Standby when switched off, so
  // this server stays reachable. A C2 on webOS 9.2 has it; a B8 on 4.4 does not.
  // It is suspended for five hours a night, when a switched-off TV sleeps fully.
  lunaCachedFn('com.webos.service.settings/getSystemSettings',
       { category: 'general', keys: ['alwaysOn', 'alwaysOnDisableStartHour', 'alwaysOnDisableStartMinute',
                                     'alwaysOnDisableEndHour', 'alwaysOnDisableEndMinute'] }, 60000, function (gn) {
    var gs = (gn && gn.settings) || {};
    var ar = gs.alwaysOn;
    if (ar !== undefined) out.alwaysReady = ar === 'on' || ar === true;
    if (ar !== undefined && gs.alwaysOnDisableStartHour !== undefined && gs.alwaysOnDisableEndHour !== undefined) {
      out.alwaysReadyOff = {
        start: clockTime(gs.alwaysOnDisableStartHour, gs.alwaysOnDisableStartMinute),
        end: clockTime(gs.alwaysOnDisableEndHour, gs.alwaysOnDisableEndMinute)
      };
    }

  lunaCachedFn('com.palm.connectionmanager/getStatus', {}, 60000, function (cm) {
    var w = cm && cm.wifi;
    out.ssid = (w && w.ssid) ? w.ssid : null;

  lunaCachedFn('com.webos.service.tv.display/getDimmingStatus', {}, 15000, function (dim) {
    out.dimming = (dim && dim.status) || null;

  lunaCachedFn('com.webos.service.tv.display/getLightSensorData', {}, 30000, function (ls) {
    var lux = null, sd = (ls && ls.sensorData) || [];
    for (var li = 0; li < sd.length; li++) {
      if (sd[li].property === 'visibleLuminance' || sd[li].property === 'luminance') {
        if (sd[li].value !== 65535 && sd[li].value !== null) lux = sd[li].value;
      }
    }
    out.lightSensor = (lux === null) ? null : { lux: lux };
    if (out.lightSensor) hasLightSensor = true;
    out.backlight = (ls && typeof ls.backlightValue === 'number') ? ls.backlightValue : null;

  appStorage(function (st) {
    out.appStorage = st;

  lunaCachedFn('com.webos.audio/getSoundOut', {}, 10000, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      out.audio_output = sound.scenario ?
        formatSoundOutput(String(sound.scenario).replace(/^mastervolume_/, '')) : 'Internal';
    }
    lunaCachedFn('com.webos.service.settings/getSystemSettings',
      { category: 'sound', keys: ['soundOutput', 'soundMode'] }, 15000,
      function (snd) {
        var rawSnd = (snd && snd.settings && snd.settings.soundOutput) ? snd.settings.soundOutput : (sound && sound.scenario ? sound.scenario : 'tv_speaker');
        out.sound = {
          output: formatSoundOutput(rawSnd),
          output_raw: rawSnd,
          mode: (snd && snd.settings && snd.settings.soundMode) || 'standard'
        };

        lunaCachedFn('com.webos.service.acb/getForegroundAppInfo', {}, 4000, function (acb) {
        var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
        if (pipe && pipe.playStateNow) {
          out.media = {
            state: String(pipe.playStateNow),
            playerType: pipe.playerType || null,
            fullScreen: pipe.isFullScreen !== false
          };
          hasMediaState = true;
        }

        lunaCachedFn('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (app) {
          if (app && app.appId) {
            var shortApp = String(app.appId).replace('com.webos.app.', '');
            out.app = shortApp;
            out.app_id = app.appId;
            // Inputs by the names given them in the TV's settings, apps by
            // their titles; the id only when neither is known.
            var isInput = inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp;
            out.app_name = inputNameMap[shortApp] || appTitles[app.appId] || shortApp;
            out.display_title = isInput ?
              (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : out.app_name;
          }

          lunaCachedFn('com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: ['backlight', 'pictureMode', 'energySaving', 'screenShift', 'logoLuminanceAdjust'] },
            10000, function (pic) {
              if (pic && pic.settings) {
                var rawDr = (pic.dimension && pic.dimension.dynamicRange) ? pic.dimension.dynamicRange : 'sdr';
                out.picture = {
                  dynamicRange: formatDynamicRange(rawDr),
                  mode: formatPicMode(pic.settings.pictureMode),
                  mode_raw: pic.settings.pictureMode || 'standard',
                  backlight: num(pic.settings.backlight, 50),
                  energySaving: pic.settings.energySaving || 'off',
                  screenShift: pic.settings.screenShift || 'off',
                  logoLuminanceAdjust: pic.settings.logoLuminanceAdjust || 'off',
                  modes: []
                };
              }
              pictureModes(function (modes) {
                if (out.picture) out.picture.modes = modes;
                refreshInstalledApps(function (apps) {
                  out.apps = apps || [];
                  out.privacy = {
                    adblock: {
                      enabled: privacyModule ? privacyModule.isAdBlockActive() : false,
                      count: (privacyModule && privacyModule.adBlockList) ? privacyModule.adBlockList('full').length : 0
                    }
                  };
                  if (!oledModule) {
                    out.capabilities = {
                      oled: false,
                      thermal: THERMAL_PRESENT,
                      emmcWear: EMMC_WEAR_PRESENT
                    };
                    out.oled = null;
                    return flushStats(out);
                  }
                  oledModule.detectOled(function (oledPanel) {
                    out.capabilities = {
                      oled: oledPanel,
                      thermal: THERMAL_PRESENT,
                      emmcWear: EMMC_WEAR_PRESENT
                    };
                    if (!oledPanel) {
                      out.oled = null;
                      return flushStats(out);
                    }
                    oledModule.refreshOledStats((pic && pic.settings) ? pic.settings : null, out.powerState, function (oledData) {
                      out.oled = oledData;
                      flushStats(out);
                    });
                  });
                });
              });
            }
          );
        });
        });
      }
    );
  });
  });
  });
  });
  });
  });
  });
  });
  });
  });
  });
  });
}

function getCapabilities(extra) {
  extra = extra || {};
  return {
    hasRemoteInfo: !!readRemoteInfo(),
    hasPnwash: fs.existsSync('/mnt/lg/cmn_data/pnwash/completedOffRsCount'),
    hasCell: !!(HARDWARE_INFO && HARDWARE_INFO.cell),
    hasHdmiProc: fs.existsSync('/proc/lg/hdmi20'),
    hasMediaState: hasMediaState,
    hasHdrStatus: fs.existsSync('/proc/lg/pe/hdr_status'),
    socArch: HARDWARE_INFO && HARDWARE_INFO.socArch,
    hasLogoLight: hasLogoLight,
    thermalPresent: THERMAL_PRESENT,
    emmcWearPresent: EMMC_WEAR_PRESENT,
    hasLightSensor: hasLightSensor,
    updateCheck: !!extra.updateCheck,
    hdmiSeen: hdmiSeen,
    hasGpuClock: gpuClockMhz() !== null,
    isOled: !!extra.isOled,
    userEntities: extra.userEntities || {}
  };
}

function getInstalledApps() {
  return installedApps;
}

function getPictureModes() {
  return lastPicModes;
}

function getCapabilitySignature() {
  var cap = [];
  for (var hs in hdmiSeen) cap.push(hs);
  if (hasMediaState) cap.push('play_state');
  return cap.sort().join(',');
}

module.exports = {
  THERMAL_PRESENT: THERMAL_PRESENT,
  EMMC_WEAR_PRESENT: EMMC_WEAR_PRESENT,
  HARDWARE_INFO: HARDWARE_INFO,
  inputNameMap: inputNameMap,
  init: init,
  rd: rd,
  num: num,
  meminfo: meminfo,
  emmcInfo: emmcInfo,
  onlineCpus: onlineCpus,
  socMhz: socMhz,
  gpuClockMhz: gpuClockMhz,
  swapBacking: swapBacking,
  wifi: wifi,
  macAddress: macAddress,
  netBytes: netBytes,
  getVideoSignal: getVideoSignal,
  readRemoteInfo: readRemoteInfo,
  getActiveHdmiDiagnostics: getActiveHdmiDiagnostics,
  getPictureEngineInfo: getPictureEngineInfo,
  formatSoundOutput: formatSoundOutput,
  formatPicMode: formatPicMode,
  formatDynamicRange: formatDynamicRange,
  pictureModes: pictureModes,
  refreshInputNames: refreshInputNames,
  refreshInstalledApps: refreshInstalledApps,
  getInstalledApps: getInstalledApps,
  getPictureModes: getPictureModes,
  getCapabilitySignature: getCapabilitySignature,
  appStorage: appStorage,
  hdmiPorts: hdmiPorts,
  hdmiInputs: hdmiInputs,
  collectProcesses: collectProcesses,
  collectCpuProcesses: collectCpuProcesses,
  detectWebosVersion: detectWebosVersion,
  detectHardwareInfo: detectHardwareInfo,
  detectDeviceInfo: detectDeviceInfo,
  detectFrontLights: detectFrontLights,
  detectLogoLight: detectFrontLights,
  collectStats: collectStats,
  clearCache: clearCache,
  getCapabilities: getCapabilities
};
