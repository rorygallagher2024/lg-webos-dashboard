'use strict';

var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;

var CATALOG = [
  {
    id: 'tvdataexchanger',
    title: 'Hotel / USB Channel Cloning',
    unit: 'tvdataexchanger.service',
    upstart: null,
    badge: '12s boot delay',
    desc: 'Synchronously polls for hotel cloning files and channel databases at boot. Safe to disable on consumer TVs.'
  },
  {
    id: 'mycar',
    title: 'Car-to-Home Telematics',
    unit: 'com.webos.service.mycar.service',
    upstart: null,
    badge: '2.1 MB RAM',
    desc: 'Hyundai/Kia Bluelink vehicle status listener in Home Dashboard. Unnecessary unless linking a connected vehicle.'
  },
  {
    id: 'camera',
    title: 'USB Camera Listener',
    unit: 'com.webos.service.camera.service',
    upstart: null,
    badge: '2.5 MB RAM',
    desc: 'Background USB webcam detection daemon. Unnecessary unless a USB webcam is physically attached.'
  },
  {
    id: 'uploadd',
    title: 'Telemetry & Diagnostics Uploader',
    unit: 'uploadd.service',
    upstart: 'uploadd',
    badge: 'Telemetry',
    desc: 'Uploads crash logs, diagnostic traces, and usage telemetry to LG servers.'
  },
  {
    id: 'rdxd',
    title: 'Remote Diagnostics Daemon',
    unit: 'rdxd.service',
    upstart: 'rdxd',
    badge: 'Flash writes',
    desc: 'Continuously logs diagnostic traces, core dumps, and event data to internal flash memory.'
  },
  {
    id: 'crashreportd',
    title: 'Jira Crash Reporter',
    unit: null,
    upstart: 'crashreportd',
    badge: 'Telemetry',
    desc: 'Background daemon on older webOS versions that generates automated crash reports.'
  },
  {
    id: 'contentminer',
    title: 'ACR Content Miner',
    unit: 'contentminer.service',
    upstart: null,
    badge: '4.2 MB RAM',
    desc: 'Scans and indexes on-screen audio/video content for advertising and viewing habit telemetry.'
  },
  {
    id: 'nudge',
    title: 'LG Promotions & Tips Popups',
    unit: 'nudge.service',
    upstart: null,
    badge: '3.1 MB RAM',
    desc: 'Pushes marketing notifications, promotional popups, and feature tips to the TV interface.'
  },
  {
    id: 'alwaysready',
    title: 'Always Ready Ambient Mode',
    unit: 'alwaysready.service',
    upstart: null,
    badge: '3.1 MB RAM',
    desc: 'Background wallpaper and ambient widget listener when the screen is in standby.'
  },
  {
    id: 'remotelogger',
    title: 'Remote Logging Daemon',
    unit: 'remotelogger.service',
    upstart: 'remotelogger',
    badge: '1.7 MB RAM',
    desc: 'Ships system log messages to remote servers.'
  }
];

var stateDir = '/var/lib/tvweb';
var disabledFilePath = null;
var initScriptPath = '/var/lib/webosbrew/init.d/20-services.sh';
var transientDir = '/run/systemd/transient';

function getSystemctl() {
  if (fs.existsSync('/bin/systemctl')) return '/bin/systemctl';
  if (fs.existsSync('/usr/bin/systemctl')) return '/usr/bin/systemctl';
  return null;
}

function getInitctl() {
  if (fs.existsSync('/sbin/initctl')) return '/sbin/initctl';
  if (fs.existsSync('/usr/sbin/initctl')) return '/usr/sbin/initctl';
  return null;
}

function getDisabledFile() {
  if (!disabledFilePath) {
    disabledFilePath = path.join(stateDir, 'disabled_services.json');
  }
  return disabledFilePath;
}

function readDisabledList() {
  try {
    var raw = fs.readFileSync(getDisabledFile(), 'utf8');
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return [];
}

function writeDisabledList(list) {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, 493); // 0755
    }
    fs.writeFileSync(getDisabledFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}

  syncBootScript(list);
}

function syncBootScript(disabledList) {
  var initDir = path.dirname(initScriptPath);
  if (!fs.existsSync(initDir)) return;

  if (!disabledList || !disabledList.length) {
    try {
      if (fs.existsSync(initScriptPath)) fs.unlinkSync(initScriptPath);
    } catch (e) {}
    return;
  }

  var lines = [
    '#!/bin/sh',
    '# tvweb managed disabled services',
    'if which systemctl >/dev/null 2>&1; then',
    '  mkdir -p /run/systemd/transient'
  ];

  var upstartJobs = [];
  for (var i = 0; i < CATALOG.length; i++) {
    var item = CATALOG[i];
    if (disabledList.indexOf(item.id) !== -1) {
      if (item.unit) {
        lines.push('  ln -sf /dev/null "/run/systemd/transient/' + item.unit + '"');
        lines.push('  systemctl stop "' + item.unit + '" 2>/dev/null');
      }
      if (item.upstart) {
        upstartJobs.push(item.upstart);
      }
    }
  }
  lines.push('  systemctl daemon-reload 2>/dev/null');

  if (upstartJobs.length) {
    lines.push('elif which initctl >/dev/null 2>&1; then');
    for (var j = 0; j < upstartJobs.length; j++) {
      lines.push('  initctl stop "' + upstartJobs[j] + '" 2>/dev/null');
    }
  }
  lines.push('fi');
  lines.push('');

  try {
    fs.writeFileSync(initScriptPath, lines.join('\n'), { mode: 493 }); // 0755
  } catch (e) {}
}

function serviceExists(item, systemctl, initctl) {
  if (systemctl && item.unit) {
    if (fs.existsSync('/etc/systemd/system/' + item.unit) ||
        fs.existsSync('/lib/systemd/system/' + item.unit) ||
        fs.existsSync('/usr/lib/systemd/system/' + item.unit)) {
      return true;
    }
  }
  if (initctl && item.upstart) {
    if (fs.existsSync('/etc/init/' + item.upstart + '.conf')) {
      return true;
    }
  }
  return false;
}

function init(options) {
  if (options && options.stateDir) {
    stateDir = options.stateDir;
    disabledFilePath = path.join(stateDir, 'disabled_services.json');
  }

  var disabled = readDisabledList();
  var systemctl = getSystemctl();

  if (systemctl && disabled.length) {
    try {
      if (!fs.existsSync(transientDir)) {
        fs.mkdirSync(transientDir, 493);
      }
      var reloaded = false;
      for (var i = 0; i < CATALOG.length; i++) {
        var item = CATALOG[i];
        if (item.unit && disabled.indexOf(item.id) !== -1) {
          var maskFile = path.join(transientDir, item.unit);
          if (!fs.existsSync(maskFile)) {
            try {
              fs.symlinkSync('/dev/null', maskFile);
              reloaded = true;
            } catch (e) {}
          }
        }
      }
      if (reloaded) {
        execFile(systemctl, ['daemon-reload'], function () {});
      }
    } catch (e) {}
  }
}

function getServices(cb) {
  var systemctl = getSystemctl();
  var initctl = getInitctl();

  if (!systemctl && !initctl) {
    return cb({ ok: true, supported: false, services: [] });
  }

  var disabledList = readDisabledList();
  var available = [];

  for (var i = 0; i < CATALOG.length; i++) {
    var item = CATALOG[i];
    if (serviceExists(item, systemctl, initctl)) {
      available.push({
        id: item.id,
        title: item.title,
        badge: item.badge,
        desc: item.desc,
        unit: item.unit || item.upstart,
        disabled: disabledList.indexOf(item.id) !== -1,
        running: false
      });
    }
  }

  if (!available.length) {
    return cb({ ok: true, supported: true, services: [] });
  }

  // Probe running state for available services
  var pending = available.length;
  function doneOne() {
    pending--;
    if (pending <= 0) {
      cb({ ok: true, supported: true, services: available });
    }
  }

  for (var j = 0; j < available.length; j++) {
    (function (svc) {
      if (svc.disabled) {
        svc.running = false;
        return doneOne();
      }
      var catItem = null;
      for (var k = 0; k < CATALOG.length; k++) {
        if (CATALOG[k].id === svc.id) { catItem = CATALOG[k]; break; }
      }
      if (systemctl && catItem && catItem.unit) {
        execFile(systemctl, ['is-active', catItem.unit], function (err, stdout) {
          svc.running = (!err && String(stdout).trim() === 'active');
          doneOne();
        });
      } else if (initctl && catItem && catItem.upstart) {
        execFile(initctl, ['status', catItem.upstart], function (err, stdout) {
          svc.running = (!err && String(stdout).indexOf('start/running') !== -1);
          doneOne();
        });
      } else {
        doneOne();
      }
    })(available[j]);
  }
}

function toggleService(id, disabled, cb) {
  var catItem = null;
  for (var i = 0; i < CATALOG.length; i++) {
    if (CATALOG[i].id === id) { catItem = CATALOG[i]; break; }
  }
  if (!catItem) {
    return cb({ ok: false, error: 'Unknown service ID: ' + id });
  }

  var systemctl = getSystemctl();
  var initctl = getInitctl();
  if (!systemctl && !initctl) {
    return cb({ ok: false, error: 'Service management is not supported on this platform' });
  }

  var list = readDisabledList();
  var idx = list.indexOf(id);

  if (disabled) {
    if (idx === -1) list.push(id);
  } else {
    if (idx !== -1) list.splice(idx, 1);
  }
  writeDisabledList(list);

  if (systemctl && catItem.unit) {
    var maskFile = path.join(transientDir, catItem.unit);
    if (disabled) {
      try {
        if (!fs.existsSync(transientDir)) fs.mkdirSync(transientDir, 493);
        if (!fs.existsSync(maskFile)) fs.symlinkSync('/dev/null', maskFile);
      } catch (e) {}
      execFile(systemctl, ['daemon-reload'], function () {
        execFile(systemctl, ['stop', catItem.unit], function () {
          cb({ ok: true, id: id, disabled: true, running: false });
        });
      });
    } else {
      try {
        if (fs.existsSync(maskFile)) fs.unlinkSync(maskFile);
      } catch (e) {}
      execFile(systemctl, ['daemon-reload'], function () {
        // Only start non-oneshot units; oneshot units like tvdataexchanger run on boot
        if (catItem.id !== 'tvdataexchanger') {
          execFile(systemctl, ['start', catItem.unit], function () {
            cb({ ok: true, id: id, disabled: false, running: true });
          });
        } else {
          cb({ ok: true, id: id, disabled: false, running: false });
        }
      });
    }
  } else if (initctl && catItem.upstart) {
    var cmd = disabled ? 'stop' : 'start';
    execFile(initctl, [cmd, catItem.upstart], function () {
      cb({ ok: true, id: id, disabled: !!disabled, running: !disabled });
    });
  } else {
    cb({ ok: true, id: id, disabled: !!disabled });
  }
}

module.exports = {
  init: init,
  CATALOG: CATALOG,
  getServices: getServices,
  toggleService: toggleService
};
