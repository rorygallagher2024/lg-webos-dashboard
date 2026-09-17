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
var THERMAL_PRESENT = fs.existsSync('/proc/lg/pm/temperature');
var EMMC_WEAR_PRESENT = fs.existsSync('/sys/block/mmcblk0/device/life_time');
var url = require('url');
var net = require('net');
var tls = require('tls');
var child_process = require('child_process');
var path = require('path');
var execFile = child_process.execFile;
var zlib = require('zlib');
var MiniMQTT = require('./lib/mqtt');
var ha = require('./lib/ha');
var updater = require('./lib/updater');
var privacy = require('./lib/privacy');
var oled = require('./lib/oled');
var zeroBuffer = MiniMQTT.zeroBuffer;

/*
 * Bump on release, and tag the release to match: the dashboard turns this into
 * a link to /releases/tag/v<version>, so a value with no tag behind it gives a
 * 404 rather than a wrong page.
 */
var TVWEB_VERSION = '0.35.2';

// ---------------------------------------------------------------- config
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
          var mode = fs.statSync(paths[i]).mode & 0777;
          if (mode !== 0600) {
            fs.chmodSync(paths[i], 0600);
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
function rd(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); }
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

var EOL_MAP = { 1: 'Normal', 2: 'Warning', 3: 'Urgent' };
var EMMC_CACHE = null;

/* eMMC DEVICE_LIFE_TIME_EST: 0x01 = 0-10% of rated write cycles used (>90% health remaining). */
function emmcInfo() {
  if (EMMC_CACHE) return EMMC_CACHE;
  var raw = rd('/sys/block/mmcblk0/device/life_time');
  var eolRaw = rd('/sys/block/mmcblk0/device/pre_eol_info');
  /*
   * Both nodes are absent on webOS 3.x. Reporting a healthy drive because the
   * wear counter could not be read is the same mistake as rendering 0 C for a
   * missing thermal sensor: it states as fact something never measured.
   */
  // The kernel prints pre_eol_info as 0x%02X, so parse the value rather than
  // match its text: '0x01' and '01' both mean Normal. 0x00 is "not defined".
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
  /*
   * The controller reports a band per region, and on a healthy drive they are
   * all the same - "0-10% / 0-10%" is one fact stated twice, and it wrapped to
   * two lines in the dashboard's cell. Collapse them when they agree; a drive
   * whose regions have diverged still shows every band, which is the case
   * where the detail earns its space.
   */
  var uniqWear = [];
  for (var u = 0; u < wearList.length; u++) {
    if (uniqWear.indexOf(wearList[u]) === -1) uniqWear.push(wearList[u]);
  }
  var wearStr = uniqWear.length ? uniqWear.join(' / ') : '0-10%';
  // The wear band inverted. Kept for anyone templating on it; nothing in this
  // project presents it, because next to `wear` it is the same fact twice.
  var healthStr = (minHealth >= 90) ? '>90% (Healthy)' : (minHealth + '% remaining');
  EMMC_CACHE = {
    life: wearStr,    // backwards-compatible with old HA discovery template
    wear: wearStr,
    health: healthStr,
    eol: eol
  };
  return EMMC_CACHE;
}

/*
 * Which CPUs are actually running. The TV parks cores under light load, but
 * /proc/lg/pm/status keeps a slot in its load vector for every core whether
 * or not it is online - a parked one reads 0, or holds whatever it last
 * reported before it went down. Observed on a G4: "load: 13 11 11 29" while
 * only cpu0-2 were online, so that trailing 29 belonged to a core that had
 * stopped. Publishing those next to live figures invents cores.
 *
 * /sys/devices/system/cpu/online is the authoritative list and gives indices
 * ("0-1", "0,2-3"), which matters because a slot's position is its core
 * number. cpu_num in the LG file is only a count, so it stands in when sysfs
 * is unavailable and the cores are assumed to be the lowest indices.
 */
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
  if (!m) return null;                      // no idea which are live
  var n = parseInt(m[1], 10), out = [];
  for (var k = 0; k < n; k++) out.push(k);
  return out;
}

/*
 * webOS 4.x reports this in kHz (1200000), webOS 9+ in MHz (1200), so a fixed
 * divisor turns a 1.2 GHz SoC into "1 MHz" on the newer sets. No TV SoC runs
 * anywhere near 10 GHz, so a value above that is taken as the kHz form.
 *
 * Only those two conventions have been seen, so the result is bounded rather
 * than trusted: a set reporting Hz would land far outside a plausible clock,
 * and nothing is better than a confident wrong figure.
 */
function socMhz() {
  var v = num(rd('/proc/lg/pm/frequency'), 0);
  if (!v || v < 0) return null;
  var mhz = Math.round(v > 10000 ? v / 1000 : v);
  return (mhz >= 100 && mhz <= 10000) ? mhz : null;
}

/*
 * What swap is actually backed by. The B8 swaps to zram, but this is not
 * universal: a G4 swaps to a flash partition (/dev/f2io-0) and leaves zram0
 * present with disksize 0. Calling both "zram" understated the cost, since
 * compressed RAM costs no writes and a partition wears the eMMC.
 *
 * The largest device wins, which is the one carrying the pages.
 */
var SWAP_BACKING_CACHE = null;

function swapBacking() {
  if (SWAP_BACKING_CACHE !== null) return SWAP_BACKING_CACHE;
  var raw = rd('/proc/swaps');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null, bestSize = -1;
  for (var i = 1; i < lines.length; i++) {          // row 0 is the header
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
      /*
       * A wired set still has a wlan0 row, reading zero across the board
       * because the radio is not associated. Reporting that as 0 dBm states a
       * measurement that was never taken - the same mistake as 0 C for a
       * missing thermal sensor.
       */
      if (!link && !level) return null;
      // webOS 9+ (C2) exposes signal as unsigned in /proc/net/wireless:
      // 181 means -75 dBm. iw confirms: "signal: -75 dBm".
      if (level > 127) level = level - 256;
      return { link: link, level: level };
    }
  }
  return null;
}

/*
 * Live first, then busiest. Ranking on byte count alone would keep choosing a
 * link that has since been unplugged: a set moved from Wi-Fi to ethernet has
 * a dormant wlan0 holding more lifetime bytes than eth0 will accumulate for
 * days, and its idle counters would report zero throughput on a busy TV -
 * which is the fault this replaced, in a new form.
 *
 * A kernel too old to publish operstate or carrier leaves every interface
 * unranked, and the busiest still wins.
 */
function ifaceRank(name) {
  var st = rd('/sys/class/net/' + name + '/operstate');
  if (st) {
    st = st.trim();
    if (st === 'up') return 2;
    if (st === 'down') return 0;
    return 1;                                       // "unknown" is not "down"
  }
  var car = rd('/sys/class/net/' + name + '/carrier');
  if (!car) return 1;
  return car.trim() === '1' ? 2 : 0;
}

/*
 * The address a magic packet has to be sent to. Waking a set is the one thing
 * this server cannot do - it is not running when the TV is off - so the README
 * documents Wake-on-LAN for it and leaves the address for the reader to find
 * in the TV's menus. The set knows it.
 *
 * Read for whichever interface the throughput came from, so a TV on Wi-Fi
 * reports its Wi-Fi address rather than a wired one with nothing plugged in.
 * An all-zero address is a placeholder for an interface that has none.
 */
var MAC_CACHE = {};

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

/*
 * Whichever interface is actually carrying traffic. This matched wlan0 alone,
 * so every wired set reported zero throughput forever - the counters it wanted
 * were on eth0. Loopback is excluded.
 */
function netBytes() {
  var raw = rd('/proc/net/dev');
  if (!raw) return null;
  var lines = raw.split('\n'), best = null;
  for (var i = 0; i < lines.length; i++) {
    // Split on the first colon only: the counters follow it, and a long byte
    // count can run straight up against it with no space.
    var idx = lines[i].indexOf(':');
    if (idx === -1) continue;                       // the two header rows
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

var cachedRemote = null;
var lastRemoteCheck = 0;

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

    /*
     * Null where the line is absent, not 0 or false. An HDMI 2.0 port has a
     * status file and reports as connected, but carries none of the 2.1 lines:
     * a B8 gives the port number and nothing else. Defaulting meant a cable
     * error count of 0 and a VRR of OFF on a set with no counter and no VRR
     * hardware, which reads as a measurement rather than as silence.
     */
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

var PIC_MODE_MAP = {
  dolbyHdrVivid: 'Dolby Vision Vivid',
  dolbyHdrCinemaBright: 'Dolby Vision Cinema Bright',
  dolbyHdrCinema: 'Dolby Vision Cinema',
  dolbyHdrCinemaHome: 'Dolby Vision Cinema Home',
  dolbyHdrStandard: 'Dolby Vision Standard',
  dolbyHdrGame: 'Dolby Vision Game',
  hdrCinema: 'HDR Cinema',
  hdrCinemaHome: 'HDR Cinema Home',
  hdrStandard: 'HDR Standard',
  hdrGame: 'HDR Game',
  cinema: 'Cinema',
  personalized: 'Personalized',   // reported by webOS 22 sets
  expert1: 'ISF Expert (Bright)',
  expert2: 'ISF Expert (Dark)',
  game: 'Game',
  standard: 'Standard',
  eco: 'Eco',
  technicolor: 'Technicolor',
  technicolorHdr: 'Technicolor HDR',
  hdrEffect: 'HDR Effect',
  vivid: 'Vivid',
  normal: 'Standard'
};

/*
 * Which picture modes the set will accept right now.
 *
 * They depend on the dynamic range of what is playing: under Dolby Vision the
 * only settable modes are the dolbyHdr* ones, and setting an SDR mode is
 * refused with "There is No matched extended item: pictureMode". A fixed list
 * therefore offers buttons that cannot work - which is what the dashboard used
 * to do, showing SDR modes against Dolby Vision content.
 *
 * getSystemSettingValues marks the currently selectable ones visible:true, and
 * that set changes with the source, so it is read rather than assumed.
 */
var lastPicModes = [];

function pictureModes(cb) {
  lunaCached('com.webos.service.settings/getSystemSettingValues',
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

function formatPicMode(mode) {
  if (!mode) return 'Standard';
  return PIC_MODE_MAP[mode] || mode;
}

function formatDynamicRange(dr) {
  if (!dr || dr === 'sdr') return 'SDR';
  if (dr === 'dolbyHdr') return 'Dolby Vision';
  if (dr === 'hdr') return 'HDR';
  if (dr === 'technicolorHdr') return 'Technicolor HDR';
  return String(dr).toUpperCase();
}

var inputNameMap = {};
var lastInputScan = 0;

function refreshInputNames(cb) {
  if (Date.now() - lastInputScan < 60000 && Object.keys(inputNameMap).length > 0) {
    if (cb) cb(inputNameMap);
    return;
  }
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
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

var TOAST_SOURCE = 'com.webos.app.home';

/* luna-send wrapper via execFile directly, avoiding /bin/sh and shell child leaks.
 * -w 2000 tells luna-send itself to time out after 2 seconds.
 * timeout: 3500 ensures Node kills the child process if it ever stalls.
 * appId, where given, becomes -a: a few services check the caller's registered
 * bus identity rather than anything in the payload, and reject everyone else
 * with "Unknown Source".
 */
function luna(uri, payload, cb, appId) {
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  execFile('/usr/bin/luna-send', args, { timeout: 3500 }, function (err, stdout) {
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (cb) cb(parsed, String(stdout || ''));
  });
}

/*
 * Cache for luna reads whose answers do not change between dashboard ticks.
 * Every luna() call is a fork+exec, and collectStats made ten of them per
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

privacy.init({ luna: luna, lunaCached: lunaCached, config: CONFIG });
oled.init({ luna: luna, config: CONFIG });

/*
 * Platform code to the processor it always means. LG reports the code either
 * as _O22_ from the env block or o22 from /proc/lg/base/chip_name, so both
 * normalise to one key.
 *
 * O24 is deliberately absent. It is the 2024 platform, and unlike the earlier
 * ones it does not name a single processor - a G4 on O24 is an Alpha 11, a C4
 * on O24 is an Alpha 9 Gen 7 - so any one name here would be wrong on half the
 * sets that report it. An unmapped code falls through to the bare code, which
 * reads "O24" rather than the raw "_O24_" that was reaching the sensor.
 */
var SOC_ARCH = {
  O22: 'Alpha 9 Gen 5 (O22)',
  O20: 'Alpha 9 Gen 3 (O20)',
  O18: 'Alpha 9 Gen 1 (O18)',
  M16P: 'Alpha 7 (M16P)',
  M16PLUS: 'Alpha 7 (M16P)'
};

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
    // Same codes, lower case and without the underscores: "o24".
    var chip = rd('/proc/lg/base/chip_name');
    if (chip) HARDWARE_INFO.socArch = socArchName(chip.trim());
  }

  // Query panelcontroller (webOS 9+)
  luna('com.webos.service.panelcontroller/getOledCellInfo', {}, function (cellRes) {
    if (cellRes && cellRes.cellInfo) HARDWARE_INFO.cell = cellRes.cellInfo;
    luna('com.webos.service.panelcontroller/getOledTconInfo', {}, function (tconRes) {
      if (tconRes && tconRes.tconParamForInstart) {
        HARDWARE_INFO.tconFirmware = tconRes.tconParamForInstart.tconFpgaFirmwareVer || null;
        HARDWARE_INFO.tconModule = tconRes.tconParamForInstart.tconModuleInfo || null;
      }
      if (cb) cb();
    });
  });
}

function detectDeviceInfo(cb) {
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName', 'firmwareVersion', 'boardType', 'sdkVersion'] },
    function (res) {
      if (res && res.modelName) {
        if (!CONFIG.device.model || CONFIG.device.model === 'OLED65B8SLC' || CONFIG.device.model === 'webOS TV') {
          CONFIG.device.model = res.modelName;
        }
        if (!CONFIG.device.name || CONFIG.device.name === 'LG webOS TV' || CONFIG.device.name === 'LG OLED B8 TV') {
          CONFIG.device.name = 'LG ' + res.modelName;
        }
        if (res.firmwareVersion) {
          CONFIG.device.sw_version = res.firmwareVersion;
        }
        console.log('device detected: ' + (CONFIG.device.name || 'LG TV') + ' (model: ' + CONFIG.device.model + ') fw: ' + (res.firmwareVersion || '?'));
      }
      if (!CONFIG.device.name) CONFIG.device.name = 'LG webOS TV';
      if (!CONFIG.device.model) CONFIG.device.model = 'webOS TV';
      detectHardwareInfo((res && res.sdkVersion) || null, function () {
        if (cb) cb();
      });
    }
  );
}

// Keyed on both the soundOutput setting and the audio service's scenario name
// with its mastervolume_ prefix removed - the two use the same output names,
// except that a scenario can also name a combination.
var SOUND_OUTPUT_MAP = ha.SOUND_OUTPUT_MAP;

function formatSoundOutput(so) {
  if (!so) return 'TV Speaker';
  return SOUND_OUTPUT_MAP[so] || so;
}

var installedApps = [];
var lastAppsScan = 0;

function refreshInstalledApps(cb) {
  var now = Date.now();
  if (installedApps.length > 0 && (now - lastAppsScan < 300000)) {
    if (cb) cb(installedApps);
    return;
  }
  luna('com.webos.applicationManager/listApps', {}, function (res) {
    if (res && Array.isArray(res.apps)) {
      var list = [];
      for (var i = 0; i < res.apps.length; i++) {
        var a = res.apps[i];
        if (a && a.id && a.visible !== false && a.id.indexOf('com.webos.app.container') !== 0) {
          list.push({
            id: a.id,
            title: a.title || a.id
          });
        }
      }
      list.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
      installedApps = list;
      lastAppsScan = Date.now();
    }
    if (cb) cb(installedApps);
  });
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

function injectKey(code, cb) {
  var fd = null;
  try {
    fd = fs.openSync('/dev/input/event1', 'w');
  } catch (e) {
    if (cb) cb(false);
    return;
  }
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
    }, 50);
  } catch (e) {
    try { fs.closeSync(fd); } catch (e3) {}
    if (cb) cb(false);
  }
}

// ---------------------------------------------------------------- stats

var prevNet = null;
/* Short server-side history of SoC temperature. The dashboard's trace would
   otherwise start empty on every load and take minutes to say anything. */
var TEMP_HISTORY_MAX = 120;
var tempHistory = [];
function pushTemp(t) {
  if (typeof t !== 'number' || isNaN(t) || t <= 0) return;   // 0 = sensor not ready
  tempHistory.push(t);
  if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
}
/*
 * Boot time, as an instant rather than a counter.
 *
 * uptime is floored to the second and the clock it is subtracted from moves in
 * milliseconds, so recomputing this every publish would shift it by a second
 * each time — a new Home Assistant state every 10s for a figure that changes
 * only when the TV restarts. Republish only when the computed instant moves
 * further than that jitter: 30s also absorbs the clock stepping when NTP lands,
 * which on a cold boot is after the first telemetry has gone out.
 */
var bootEpoch = 0;
function bootTime(uptimeSec) {
  var computed = Date.now() - uptimeSec * 1000;
  if (Math.abs(computed - bootEpoch) > 30000) bootEpoch = computed;
  return new Date(bootEpoch).toISOString();
}

var lastStats = null;
var lastStatsTime = 0;
var isCollecting = false;
var statsWaiters = [];

function collectStats(cb) {
  var now = Date.now();
  // Return cached result if fresh (< 1.5 seconds old)
  if (lastStats && (now - lastStatsTime < 1500)) {
    return cb(lastStats);
  }

  // Queue callback and serialize execution
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
  if (liveCpus) {
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
  // Same interface both samples, or the delta is between two different NICs -
  // switching from Wi-Fi to ethernet would otherwise report one huge burst.
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

  var out = {
    ok: true,
    time: Date.now(),
    tvwebVersion: TVWEB_VERSION,
    device: {
      id: CONFIG.device.id || 'lg_tv',
      name: CONFIG.device.name || 'LG webOS TV',
      model: CONFIG.device.model || 'webOS TV'
    },
    system: {
      webos: HARDWARE_INFO.webos,
      firmware: CONFIG.device.sw_version || null
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
    /*
     * The thermal sensor is not populated immediately after boot: for roughly
     * the first 80 seconds /proc/lg/pm/temperature reads a literal 0, which is
     * not a measurement. Reporting it would put a false 0C spike into Home
     * Assistant's history on every reboot, so treat 0 as "not ready yet".
     */
    temp: (function () {
      var t = num(rd('/proc/lg/pm/temperature'), null);
      // Anything <= 0 is the sensor not being ready, not a reading. Matches the
      // guard in pushTemp, so the reported value and the history agree.
      return (t !== null && t > 0) ? t : null;
    })(),
    temps: null,   // filled in below from the ring buffer
    /*
     * Across the whole processor, not the busiest core.
     * /proc/lg/pm/current_load is the peak: measured on a B8 it matched
     * max(cores) on every sample, so a single busy core reported the set as
     * pegged while three others idled. It is still reported, as loadPeak.
     */
    load: coreLoads.length
      ? Math.round(coreLoads.reduce(function (a, b) { return a + b; }, 0) / coreLoads.length)
      : num(rd('/proc/lg/pm/current_load'), null),
    loadPeak: coreLoads.length
      ? Math.max.apply(null, coreLoads)
      : num(rd('/proc/lg/pm/current_load'), null),
    mhz: socMhz(),
    cores: coreLoads,
    // Total slots, so the dashboard can say how many are parked rather than
    // leaving the figure count changing with no explanation.
    coresTotal: coreSlots.length,
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    swap: { total: mi.SwapTotal || 0, free: mi.SwapFree || 0, backing: swapBacking() },
    uptime: uptimeSec,
    bootTime: bootTime(uptimeSec),
    loadavg: (rd('/proc/loadavg') || '').split(' ').slice(0, 3),
    wifi: wifi(),
    net: rate,
    /*
     * Cumulative counters for the interface the rate came from, so the two
     * always describe the same link. Kernel counters, so they reset at boot
     * and start from zero on whichever interface is in use - Wi-Fi or wired.
     */
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

  pushTemp(out.temp);   // pushTemp already ignores non-numbers
  out.temps = tempHistory.slice();

  // Refresh input names if cache expired
  refreshInputNames();

  // Chained Luna queries: power -> sound -> soundSettings -> foregroundApp -> picture settings -> apps
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    out.powerState = mapPowerState(pw && pw.state);
    out.screenSaver = isScreenSaver(out.powerState);
    out.screensaverMode = screensaverMode();
    out.screensaverLevel = screensaverLevel();
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'time', keys: ['sleepTimer'] }, 30000, function (tm) {
    out.sleepTimer = (tm && tm.settings && tm.settings.sleepTimer) || 'off';
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'option', keys: ['standByLight', 'logoLight', 'powerOnLight'] }, 60000, function (op) {
    var os = (op && op.settings) || {};
    out.lights = {
      standby: os.standByLight === 'on',
      logo: os.logoLight === 'on',
      powerOn: os.powerOnLight === 'on',
      hasLogo: hasLogoLight === true
    };
    out.gpuMhz = gpuClockMhz();
  lunaCached('com.palm.connectionmanager/getStatus', {}, 60000, function (cm) {
    // Network name, so the Wi-Fi figures say which network they refer to.
    var w = cm && cm.wifi;
    out.ssid = (w && w.ssid) ? w.ssid : null;
  lunaCached('com.webos.service.tv.display/getDimmingStatus', {}, 15000, function (dim) {
    // ABL / logo dimming activity. OLED only in practice.
    out.dimming = (dim && dim.status) || null;
  lunaCached('com.webos.service.tv.display/getLightSensorData', {}, 30000, function (ls) {
    /*
     * Ambient light sensor. Not every set has one: a model without it still
     * answers, reporting 65535 (0xFFFF) for every channel. Treat that as
     * absent rather than publishing a nonsense lux figure.
     */
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
  lunaCached('com.webos.audio/getSoundOut', {}, 10000, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      /*
       * The audio scenario names the output the way the audio service does -
       * "mastervolume_headphone" - which is an internal identifier, not a
       * reading. The prefix is the volume domain, and the rest is the same
       * output name the sound setting uses.
       */
      out.audio_output = sound.scenario ?
        formatSoundOutput(String(sound.scenario).replace(/^mastervolume_/, '')) : 'Internal';
    }
    lunaCached('com.webos.service.settings/getSystemSettings',
      { category: 'sound', keys: ['soundOutput', 'soundMode'] }, 15000,
      function (snd) {
        var rawSnd = (snd && snd.settings && snd.settings.soundOutput) ? snd.settings.soundOutput : (sound && sound.scenario ? sound.scenario : 'tv_speaker');
        out.sound = {
          output: formatSoundOutput(rawSnd),
          output_raw: rawSnd,
          mode: (snd && snd.settings && snd.settings.soundMode) || 'standard'
        };
        /*
         * The TV's own media pipeline. applicationManager says which app is in
         * front; this says what that app's player is doing.
         *
         * It describes the TV, not the source: with an external input it reads
         * "playing" for as long as the HDMI pipeline is up, whatever the box on
         * the other end is doing. Useful for the built-in apps, not a transport
         * state for anything on HDMI.
         */
        lunaCached('com.webos.service.acb/getForegroundAppInfo', {}, 4000, function (acb) {
        var pipe = (acb && Array.isArray(acb.acbs)) ? acb.acbs[0] : null;
        if (pipe && pipe.playStateNow) {
          out.media = {
            state: String(pipe.playStateNow),
            playerType: pipe.playerType || null,
            fullScreen: pipe.isFullScreen !== false
          };
          hasMediaState = true;
        }
        lunaCached('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (app) {
          if (app && app.appId) {
            var shortApp = String(app.appId).replace('com.webos.app.', '');
            out.app = shortApp;
            out.app_id = app.appId;
            out.app_name = inputNameMap[shortApp] || shortApp;
            out.display_title = (inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp) ?
              (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : shortApp;
          }
          lunaCached('com.webos.service.settings/getSystemSettings',
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
                    enabled: privacy.isAdBlockActive(),
                    count: privacy.ADBLOCK_DOMAINS.length
                  }
                };
                oled.detectOled(function (oledPanel) {
                  /* webOS 3.x exposes no thermal sensor at all: the file simply
                     does not exist, /sys/class/thermal is empty and there is no
                     hwmon. That is different from the ~80s post-boot window where
                     the file exists but reads 0, so report it as a capability and
                     let the UI say "none" rather than imply a pending reading. */
                  out.capabilities = { oled: oledPanel, thermal: THERMAL_PRESENT,
                                       emmcWear: EMMC_WEAR_PRESENT };
                  if (!oledPanel) {
                    out.oled = null;
                    return flushStats(out);
                  }
                  oled.refreshOledStats((pic && pic.settings) ? pic.settings : null, out.powerState, function (oledData) {
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
  });   // close appStorage
  });   // close connectionmanager
  });   // close light sensor
  });   // close dimming
  });   // close option settings
  });   // close time settings
  });   // close getPowerState
}

// ---------------------------------------------------------------- processes
/*
 * Read-only process list, loaded on demand rather than folded into the
 * telemetry payload - it answers "what is using the memory" when someone
 * looks, and there is no reason to publish it to MQTT every ten seconds.
 *
 * Deliberately no kill action. Closing a stuck app is what closeByAppId is
 * for, which lets the app manager tear down cleanly; most of these respawn
 * anyway, and surface-manager is the compositor.
 */
/*
 * A readable name for a process, from its argv.
 *
 * comm is not enough: the kernel caps it at 15 characters, so every LG app
 * arrived as "com.webos.app.i" whatever it really was.
 *
 * WebAppMgr needs more than a basename. It is webOS's Chromium, and Chromium
 * runs one process per role from a single binary - so a TV with four web apps
 * warm shows five identical rows called WebAppMgr, which reads as something
 * gone wrong rather than as the browser doing its job. The role is in --type,
 * absent for the browser process itself, and a renderer that loads an app's
 * V8 snapshot names the app in the path.
 */
function procName(comm, args) {
  var bin = String(args).split(/\s+/)[0].replace(/^.*\//, '');

  if (bin === 'WebAppMgr') {
    var app = args.match(/\/usr\/palm\/applications\/([^\/\s]+)/);
    if (app) return 'WebAppMgr (' + app[1].replace(/^com\.webos\.app\./, '') + ')';
    var type = args.match(/--type=(\w+)/);
    return 'WebAppMgr (' + (type ? type[1] : 'browser') + ')';
  }

  /*
   * Neither field is reliable on its own. comm is the name the process chose,
   * but the kernel caps it at 15 characters. argv[0] is complete but is
   * sometimes not a name at all - the broadcast service runs
   * /mnt/lg/lgapp/RELEASE and calls itself tvservice.
   *
   * So: comm unless it is exactly at the cap, which is what a clipped name
   * looks like, and then argv[0] to recover the rest of it.
   */
  return (comm && comm.length < 15) ? comm : (bin || comm);
}

/*
 * CPU per process, over a short window.
 *
 * `ps -o pcpu` on this busybox reports the average since the process started,
 * so anything that worked hard at boot reads high forever - systemd sits at
 * 2.4% on an idle set. The only way to say what is busy now is to read the
 * counters twice and take the difference.
 *
 * Percentages are of the whole machine rather than of one core, so they can be
 * compared with the CPU figure on the Metrics tab and add up to roughly it. A
 * process pegging one core of three reads 33%, not 100%.
 */
var CPU_WINDOW_MS = 700;

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
      /*
       * The command sits in brackets and may itself contain a bracket or a
       * space, so the fields are counted from the last one rather than by
       * splitting the line. After it the first field is the state, which is
       * the third overall - utime and stime are the fourteenth and fifteenth.
       */
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

/*
 * The whole command line, the way `ps -o args` gives it - procName needs more
 * than argv[0], since a web app is named by the application path further along
 * it. Kernel threads have none, and return empty.
 */
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
    /*
     * Seen once, immediately after a restart, and not reproduced since: the
     * counters read the same twice, which leaves nothing to divide by. Take
     * one more window rather than handing back an error for something that
     * clears itself.
     */
    if (elapsed <= 0) {
      if (retried) return cb({ ok: false, error: 'the CPU counters did not move' });
      return collectCpuProcesses(cb, true);
    }

    var rows = [], busy = 0;
    for (var pid in second.procs) {
      if (!second.procs.hasOwnProperty(pid)) continue;
      var was = first.procs[pid];
      // A process that started inside the window has nothing to compare
      // against, so its whole total would read as if spent in it.
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

// ---------------------------------------------------------------- hdmi / misc
/*
 * GPU clock. /proc/lg/sys/status carries the PLL outputs in Hz.
 */
function gpuClockMhz() {
  var raw = rd('/proc/lg/sys/status');
  if (!raw) return null;
  var m = raw.match(/gpu pll out\s*:\s*(\d+)/i);
  return m ? Math.round(parseInt(m[1], 10) / 1000000) : null;
}

/*
 * Whether the screen saver is on screen right now. The same file already read
 * for the GPU clock carries it as "ss: OFF".
 *
 * There has been a control to start one since #24 but no way to see whether
 * it took: turnOnScreenSaver returns true whether or not anything answered the
 * request, so the only honest confirmation is the set saying so itself.
 *
 * A set that does not publish the field reports nothing rather than "off",
 * which would claim a screen saver is not running on a TV that never says.
 */


/*
 * App storage. Separate partition from cmn_data, and the one that actually
 * fills up and makes installs fail.
 */
var cachedAppStorage = null;
var lastAppStorageCheck = 0;
var APP_STORAGE_TTL = 60000;

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

/*
 * HDMI PHY state, straight off the receiver. Loaded on demand rather than in
 * telemetry: four ports of timing detail is a lot to publish every ten seconds
 * and it only matters when someone is looking at it.
 *
 * The PHY nodes are port0..port3 while the TV numbers its inputs HDMI 1..4,
 * and the obvious port+1 mapping is wrong: on a set whose only live input is
 * HDMI 2 (eim reports activate/chosen true, a CEC device present, everything
 * else empty) the port carrying signal is port2, not port1. There is no
 * hotplug or EDID field to pin the rest of the mapping down, so this does not
 * guess. Ports are reported as-is, and the input the TV says is active is
 * matched to the one port carrying signal when exactly one of each exists.
 */
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

    // Format 2 (webOS 9+ / HDMI 2.1 driver): Sig:[3840](4400)x[2160](2250)@[120]Hz
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

/*
 * Inputs as the TV describes them, with the live PHY figures attached to the
 * active one. The labels are the TV's own, so a renamed input reads "Apple TV"
 * rather than a port number this code guessed at.
 */
function hdmiInputs(cb) {
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    var devs = (res && res.devices) || [];
    var ports = hdmiPorts();
    var signalling = [];
    for (var p = 0; p < ports.length; p++) if (ports[p].connected) signalling.push(ports[p]);

    var inputs = [];
    var activeIdx = -1;
    for (var d = 0; d < devs.length; d++) {
      if (!devs[d].id || String(devs[d].id).indexOf('HDMI') !== 0) continue;
      if (devs[d].activate) activeIdx = inputs.length;
      // On webOS <= 8, lastUniqueId 255 means nothing ever identified over CEC.
      // On webOS 9+, lastUniqueId is -1 when empty.
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
    // Only claim a pairing when it is unambiguous.
    if (activeIdx !== -1 && signalling.length === 1) {
      inputs[activeIdx].signal = signalling[0];
    }
    cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: (activeIdx !== -1 && signalling.length === 1) });
  });
}


/*
 * Power state. tvpower reports the panel separately from the system: a set can
 * be "Active" with the screen lit, or "ScreenOff" with the system running and
 * the panel blanked - which is exactly what the Screen Off control does. The
 * dashboard previously showed neither, so blanking the panel changed nothing
 * on screen and the source kept reading as though something were displayed.
 */
var POWER_STATES = {
  'active':        ['On', true,  true],
  'screenoff':     ['Screen off', true,  false],
  'activestandby': ['Standby', false, false],
  'suspend':       ['Standby', false, false],
  'poweroff':      ['Off', false, false],
  'prepared':      ['Starting up', true, false],
  // tvpower reports a running screen saver as a power state of its own.
  'screensaver':   ['Screen Saver', true,  true]
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
  // Unknown state: report it verbatim rather than guessing at a friendly name.
  return { raw: raw || null, label: raw || 'Unknown', systemOn: true, screenOn: true };
}



// ---------------------------------------------------------------- controls
var INPUTS = ha.INPUTS;

// Verified against the settings service: 15 is rejected, 10 and 90 are not.
// Set from collectStats: sets without the hardware report 65535 and get null.
var hasLightSensor = false;

/*
 * Which HDMI diagnostics this set reports, one flag per field.
 *
 * Latched rather than read live, because hdmi_diag is absent whenever no HDMI
 * source is active - on the Home screen, on Live TV, on an app - and that is
 * not the same as the set being unable to report it. Once seen, the entity
 * stays; a field the set never reports never gets one.
 *
 * Per field because the block is not all or nothing. An HDMI 2.0 port reports
 * as connected and fills in none of the 2.1 lines, so asking only whether the
 * block existed gave a B8 six entities it could never answer.
 */
var hdmiSeen = {};

/*
 * Whether this set reports a media play state at all. com.webos.service.acb
 * does not exist on webOS 9 - a C2 answers "Service does not exist" - so the
 * sensor there could only ever read unknown. Latched like the HDMI fields,
 * because the service also returns nothing when no pipeline is running, which
 * is not the same as the service being absent.
 */
var hasMediaState = false;


/*
 * Screen savers.
 *
 * The platform's screen saver is a plain QML app on both firmwares, sitting on
 * a read-only overlay, so a replacement is bind-mounted over it the same way
 * the ad blocker stacks a hosts file. LG's own appinfo.json is copied across
 * rather than written from scratch: it carries the window type and per-model
 * flags, and only `main` needs to resolve to our QML, which it does once the
 * directory underneath it is ours.
 *
 * The marker file inside the mount is what "which screen saver is running" is
 * read from - the live mount answers that, a stored preference only says what
 * was asked for.
 */
var SCREENSAVER_APP_DIR = '/usr/palm/applications/com.webos.app.screensaver';
var SCREENSAVER_DIR = '/var/lib/tvweb/screensaver';
var SCREENSAVER_MARKER = '.tvweb-screensaver';
var SCREENSAVER_LEVEL_MARKER = '.tvweb-brightness';

// Read from the mount rather than from a stored preference, for the same
// reason the mode is: the file that is actually staged is the answer.
function screensaverLevel() {
  try {
    var v = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, SCREENSAVER_LEVEL_MARKER), 'utf8').trim();
    if (v === 'bright') return 'bright';
  } catch (e) {}
  return 'dim';
}

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
  vitals: {
    label: 'Panel vitals',
    description: "The set's own readings - panel hours, pixel refresher countdown, temperature.",
    qml: 'screensavers/vitals.qml'
  }
};

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
      available: k === 'stock' || !!assetPath(SCREENSAVERS[k].qml)
    });
  }
  return { ok: true, current: cur, level: screensaverLevel(),
           modes: out, writable: CONFIG.allowControl };
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

/*
 * The staged app keeps LG's manifest - the id, window type and permissions the
 * screen saver role expects - but not its type. A webOS 10 set ships the screen
 * saver as a Flutter app, payload in lib/ and data/flutter_assets, and the mount
 * puts a QML file where that payload was: SAM begins a launch that never draws,
 * and tvpower parks at "Screen Saver Ready" and refuses every later request with
 * "Invalid State change Request". Point type and main at what is actually
 * staged. Where the stock screen saver is already QML these are the values it
 * carried anyway.
 */
function stageScreensaverAppinfo() {
  var stock = fs.readFileSync(path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8');
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

/*
 * SAM reads every appinfo.json once, when it starts, and hands an app to the
 * runner that copy names - a manifest swapped underneath it goes unnoticed.
 * /usr/palm/applications is "system_builtin" in sam-conf.json, so no install
 * event covers it, and the bus offers no rescan: the service has to be
 * restarted. Compare what SAM holds against the manifest now visible at the app
 * directory, and restart only when they differ - which is the two swaps that
 * change the type, stock to a replacement and back. A set whose screen saver is
 * QML to begin with never differs and never pays for this.
 */
function ensureScreensaverRunner(cb) {
  var staged;
  try {
    staged = JSON.parse(fs.readFileSync(
      path.join(SCREENSAVER_APP_DIR, 'appinfo.json'), 'utf8')).type;
  } catch (e) {
    return cb(false);
  }
  luna('com.webos.applicationManager/getAppInfo', { id: 'com.webos.app.screensaver' }, function (r) {
    var cached = r && r.appInfo && r.appInfo.type;
    // No answer means the bus is not up yet. Leave the service alone.
    if (!cached || cached === staged) return cb(false);
    console.log('screensaver: sam holds the app as "' + cached + '" and it is now "'
                + staged + '" - restarting sam so it reads the manifest again');
    /*
     * systemd, even though /etc/init/sam.conf is still on disk: upstart is not
     * the init on this platform and initctl is inert.
     *
     * --no-block because the stop alone can take the best part of a minute -
     * every app SAM started is in its cgroup and gets waited on, then killed.
     * Nothing here needs to see the end of that, and a client that gives up on
     * a timeout only orphans a restart that is happening anyway.
     */
    execFile('/bin/systemctl', ['restart', '--no-block', 'sam'], { timeout: 10000 }, function (e) {
      if (e) console.error('screensaver: could not restart sam: ' + e.message);
      cb(!e);
    });
  });
}

/*
 * Two things go stale when the screen saver is swapped: what SAM thinks the app
 * is, and the copy it has already loaded. A service restart settles the first
 * and closes every app on the way, so the lighter refresh is for the other case.
 */
function settleScreensaverApp(cb) {
  ensureScreensaverRunner(function (samRestarted) {
    if (samRestarted) return cb();
    restartScreensaverApp(cb);
  });
}

/*
 * Unmount first, always. The stock appinfo.json has to be read from the real
 * app directory, and while a replacement is mounted that is exactly what is
 * hidden.
 */
function setScreensaver(mode, level, cb) {
  if (!SCREENSAVERS[mode]) return cb({ ok: false, error: 'unknown screen saver: ' + mode });
  level = (level === 'bright') ? 'bright' : 'dim';

  execFile('/bin/umount', [SCREENSAVER_APP_DIR], { timeout: 4000 }, function () {
    if (mode === 'stock') {
      lastStats = null;
      return settleScreensaverApp(function () {
        cb({ ok: screensaverMode() === 'stock', current: screensaverMode(), level: screensaverLevel() });
      });
    }

    var src = assetPath(SCREENSAVERS[mode].qml);
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
      lastStats = null;
      settleScreensaverApp(function () {
        var now = screensaverMode();
        cb({ ok: !err && now === mode, current: now, level: screensaverLevel(),
             error: (!err && now === mode) ? undefined : 'the mount did not take' });
      });
    });
  });
}

/*
 * The QML is read once at launch, so a screen saver already running is still
 * the old one and has to go before the swap means anything.
 *
 * One that is on screen is dismissed with a key rather than closed outright.
 * tvpower hands a screen saver request to a client and waits to be answered,
 * and killing the client mid-handshake leaves the service waiting on a process
 * that no longer exists: every later request is then refused as busy until the
 * set is power cycled. A key press lets it finish and exit on its own terms.
 */
/*
 * The vitals screen saver reads /api/stats from the server on this TV. The
 * port is configurable and the API refuses an unauthenticated read when a
 * token is set, so the address is written in here rather than guessed by the
 * QML.
 */
function writeScreensaverQml(src, level) {
  var qml = fs.readFileSync(src, 'utf8')
    .replace(/__TVWEB_URL__/g,
      'http://127.0.0.1:' + (CONFIG.port || 8080) + '/api/stats' +
      (CONFIG.token ? '?k=' + encodeURIComponent(CONFIG.token) : ''))
    // How bright to draw. The screen saver decides what that means for its own
    // palette; this only says which of the two was asked for.
    .replace(/__TVWEB_LEVEL__/g, level === 'bright' ? '1' : '0');
  fs.writeFileSync(path.join(SCREENSAVER_DIR, 'qml', 'main.qml'), qml);

  /*
   * Anything else in the screen saver folder goes with it. The starfield draws
   * its points from an image, and the mount replaces the whole app directory,
   * so a file left behind in assets is a file the QML cannot open.
   */
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

/*
 * The mount points at a directory, and what was staged into it stays there
 * across reboots - so an upgrade that ships a corrected screen saver would
 * otherwise never reach the TV until someone picked the mode again. Rewriting
 * the file in place needs no unmount and no restart: the next screen saver to
 * launch reads it.
 */
function restageScreensaver() {
  var mode = screensaverMode();
  if (mode === 'stock') return;
  var src = assetPath(SCREENSAVERS[mode].qml);
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
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    if (!isScreenSaver(mapPowerState(pw && pw.state))) {
      // Nothing drawing, so nothing is mid-handshake and the app - idle or
      // absent - can be closed so the next launch reads the new QML.
      return luna('com.webos.applicationManager/closeByAppId',
                  { id: 'com.webos.app.screensaver' }, function () { cb(); });
    }
    injectKey(KEY_BACK, function () {
      setTimeout(function () {
        luna('com.webos.applicationManager/closeByAppId', { id: 'com.webos.app.screensaver' }, function () {
          // It was on screen when the swap happened, so put the new one up in
          // its place rather than leaving the set on whatever was behind it.
          setTimeout(function () {
            luna('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function () { cb(); });
          }, 1500);
        });
      }, 1500);
    });
  });
}

/*
 * Front-panel lights. The "option" settings category carries standByLight,
 * logoLight and powerOnLight on every set, whether or not the hardware is
 * fitted - tv.model.logoLight is the capability flag, and reads false on a
 * B8, which has only a standby LED. Ask the model, not the setting.
 */
var hasLogoLight = null;   // null = not yet determined

function detectLogoLight(cb) {
  if (hasLogoLight !== null) return cb(hasLogoLight);
  luna('com.webos.service.config/getConfigs',
    { configNames: ['tv.model.logoLight'] },
    function (res) {
      var v = res && res.configs && res.configs['tv.model.logoLight'];
      // Absent means the model does not declare it; treat that as no hardware.
      hasLogoLight = (v === true);
      console.log('front lights: standby LED' + (hasLogoLight ? ' + logo light' : ' only (no logo light on this model)'));
      cb(hasLogoLight);
    });
}

/*
 * Remote navigation. Sent through the network input service rather than written
 * to /dev/input: it is a service call, and the TV accepts it whatever is in the
 * foreground.
 *
 * Arrows and enter are the standard evdev codes. Back is LG's own - 412, the
 * IR_KEY_BACK in /usr/share/X11/xkb/keycodes/lg less the 8 that xkb adds - and
 * measured on a C2 it is the one that acts; evdev's 158 is taken as a dismissal
 * rather than a step back. The service refuses anything above about 512, which
 * rules out the rest of LG's table, and no code was found for Home at all, so
 * that launches the home app instead.
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

// What the settings service accepts for logoLuminanceAdjust, per
// getSystemSettingValues on a B8. "strong" is the strongest, not an on/off.
var LOGO_DIMMING_VALUES = ['off', 'light', 'strong'];

function doControl(action, value, cb) {
  if (!CONFIG.allowControl) return cb({ ok: false, error: 'controls disabled in config' });

  var origCb = cb;
  cb = function (r) {
    if (r && r.ok) { lastStats = null; clearLunaCache(); }
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
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

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
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'logoDimming':
      var logoVal = String(value || '').trim().toLowerCase();
      if (LOGO_DIMMING_VALUES.indexOf(logoVal) === -1) {
        return cb({ ok: false, error: 'logo dimming takes ' + LOGO_DIMMING_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'picture', settings: { logoLuminanceAdjust: logoVal } },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'standbyLight':
    case 'logoLight':
      var lightKey = (action === 'standbyLight') ? 'standByLight' : 'logoLight';
      var lightOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var lightPayload = { category: 'option', settings: {} };
      lightPayload.settings[lightKey] = lightOn ? 'on' : 'off';
      return luna('com.webos.service.settings/setSystemSettings', lightPayload,
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'serviceMenuLock':
      return oled.setServiceMenuLock(!!(value && value.locked), cb);

    case 'serviceMenuOpen':
      return oled.openServiceMenu(String((value && value.menu) || 'ezAdjust'), cb);

    case 'oledProtection':
      var prot = (value && typeof value === 'object') ? value : {};
      return oled.setOledProtection(String(prot.key || ''), !!prot.enabled, cb);

    case 'rcu':
      var rcuName = String(value || '').trim().toLowerCase();
      if (rcuName === 'home') {
        // No keycode reaches the home screen - the service rejects LG's own -
        // so ask the application manager for it directly.
        return luna('com.webos.applicationManager/launch', { id: 'com.webos.app.home' },
                    function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });
      }
      if (!RCU_KEYS.hasOwnProperty(rcuName)) {
        return cb({ ok: false, error: 'unknown key: ' + rcuName });
      }
      return luna('com.webos.service.networkinput/test/sendKeyCode',
                  { keyCode: RCU_KEYS[rcuName] },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'screensaverMode':
      /*
       * The mode and how brightly to draw it are staged together: both are
       * written into the same file, so setting one without the other would
       * quietly reset it.
       */
      var ssMode = value, ssLevel = screensaverLevel();
      if (value && typeof value === 'object') {
        ssMode = value.mode;
        if (value.level) ssLevel = value.level;
      }
      return setScreensaver(String(ssMode || '').trim(), ssLevel, function (r) {
        lastStats = null;
        cb(r);
      });

    case 'screensaver':
      /*
       * One control for both directions. Nothing turns a screen saver off -
       * tvpower publishes turnOnScreenSaver and the registerScreenSaverRequest
       * pair, and no more - so it is dismissed the way the remote does it, with
       * a key press the screen saver consumes before anything behind it sees.
       */
      return luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
        if (isScreenSaver(mapPowerState(pw && pw.state))) {
          return injectKey(KEY_BACK, function (ok) {
            lastStats = null;
            cb(ok ? { ok: true } : { ok: false, error: 'could not reach the remote input device' });
          });
        }
        /*
         * turnOnScreenSaver does not draw anything itself. tvpower asks whatever
         * has registered a screen saver request to show one, and returns true
         * whether or not anything answers. An HDMI input or Live TV registers
         * nothing, because the screen saver exists to protect the panel from a
         * static image, not to interrupt video. So on those sources the call
         * reports success and nothing happens; say so instead.
         */
        luna('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
          var fgId = (fg && fg.appId) ? String(fg.appId).replace('com.webos.app.', '') : '';
          if (/^hdmi[1-4]$/.test(fgId) || fgId === 'livetv') {
            return cb({ ok: false, error: 'the screen saver is only available from an app, not from ' + fgId });
          }
          luna('com.webos.service.tvpower/power/turnOnScreenSaver', {}, function (r) {
            lastStats = null;
            if (r && r.returnValue) return cb({ ok: true });
            /*
             * tvpower refuses in more places than the two guarded above - a
             * webOS 9 set turns it down on its own home screen with "Invalid
             * State change Request". Which contexts allow it is the TV's to
             * decide, so pass its answer along rather than guessing at a list.
             */
            cb({ ok: false, error: (r && r.errorText)
              ? 'the TV would not start a screen saver here: ' + r.errorText
              : 'the TV would not start a screen saver from ' + (fgId || 'this source') });
          });
        });
      });

    case 'toast':
      /* Both the payload's sourceId and luna-send's -a have to name an app the
         bus already knows; "tvweb" is rejected as an Unknown Source. */
      return luna('com.webos.notification/createToast',
                  { sourceId: TOAST_SOURCE, message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue), error: r && r.errorText }); },
                  TOAST_SOURCE);

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
      return updater.checkForUpdate(true, function (e, summary) {
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
    fs.chmodSync(tmp, 0600);
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

function authed(q) {
  return !CONFIG.token || q.k === CONFIG.token;
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
    var mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (ASSET_CACHE[file]) {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': ASSET_CACHE[file].length,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(ASSET_CACHE[file]);
    }
    return fs.readFile(file, function (e, buf) {
      if (e) return send(res, 500, JSON.stringify({ ok: false, error: 'read failed' }));
      ASSET_CACHE[file] = buf;
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    });
  }

  if (pathname.indexOf('/api/') === 0 && !authed(u.query)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (pathname === '/api/caps') {
    return send(res, 200, JSON.stringify({
      ok: true, allowControl: CONFIG.allowControl, allowPower: CONFIG.allowPower
    }));
  }

  if (pathname === '/api/screensaver') {
    return send(res, 200, JSON.stringify(screensaverList()));
  }

  if (pathname === '/api/hdmi') {
    return hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/servicemenu') {
    return oled.serviceMenuState(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/oledcare') {
    return oled.readOledProtections(function (live) {
      collectStats(function (st) {
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
    return collectCpuProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    return collectProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/privacy') {
    return privacy.collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (pathname === '/api/stats') {
    return collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  /* Reports what is known, and never checks on its own: the dashboard polls
     this, and a poll that reached GitHub would be a request per viewer. */
  if (pathname === '/api/update') {
    return send(res, 200, JSON.stringify(updater.updateSummary()));
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    if (!authed(u.query)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
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
    if (!authed(u.query)) return send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized' }));
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
    detectLogoLight(function () {});
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
      installedApps: installedApps,
      pictureModes: lastPicModes,
      allowPower: CONFIG.allowPower
    });

    entities = ha.filterWithholds(entities, {
      discPfx: discPfx,
      devId: devId,
      publishFn: function (topic, payload, retain) {
        mqttClient.publish(topic, payload, retain);
      },
      capabilities: {
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
        updateCheck: !!(CONFIG.update && CONFIG.update.check),
        hdmiSeen: hdmiSeen,
        hasGpuClock: gpuClockMhz() !== null,
        isOled: oled.getIsOled(),
        userEntities: (CONFIG.mqtt && CONFIG.mqtt.entities) || {}
      }
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
    collectStats(function(s) {
      mqttClient.publish(telemetryTopic, JSON.stringify(s), false);
      MQTT_STATUS.lastPublish = Date.now();
      /*
       * Reconcile the panel switch against what the TV actually reports.
       * It used to be published only when the command arrived over MQTT, so
       * blanking the panel from the dashboard, the remote, or the TV's own
       * menus left Home Assistant asserting the opposite indefinitely.
       * Driving it from powerState makes it self-correcting whatever the
       * change came from.
       */
      if (s.powerState && typeof s.powerState.screenOn === 'boolean') {
        mqttClient.publish(stateScreenTopic, s.powerState.screenOn ? 'ON' : 'OFF', true);
      }
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
      var cap = [];
      for (var hs in hdmiSeen) cap.push(hs);
      if (hasMediaState) cap.push('play_state');
      cap = cap.sort().join(',');
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
    // Deliberately not asserting a screen state here: publishTelemetry below
    // sets it from what the TV reports. Publishing a retained 'ON' on every
    // reconnect meant a restart silently flipped Home Assistant back to on.
    // Resolve the panel type first: publishDiscovery filters on it, and on a
    // first connect it would otherwise still be undetermined.
    // The app select's options come from listApps, which on a first connect
    // has not been scanned yet - without this it publishes the fallback list.
    oled.detectOled(function () {
      detectLogoLight(function () {
        refreshInstalledApps(function () { publishDiscovery(); });
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
      doControl(turnOff ? 'screenOff' : 'screenOn', null, function(r) {
        if (r && r.ok) {
          mqttClient.publish(stateScreenTopic, turnOff ? 'OFF' : 'ON', true);
        }
      });
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

  restageScreensaver();

  detectDeviceInfo(function() {
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
