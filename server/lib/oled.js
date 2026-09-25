// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;
var fs = require('fs');

var SERVICE_MENU_APP = 'com.webos.app.factorywin';
var SERVICE_MENUS = { ezAdjust: 1, inStart: 1 };
var OLED_EPL = 'com.webos.service.oledepl';
var OLED_SYSPROP = 'com.webos.service.tv.systemproperty';

var luna = null;
var config = {};
var isOled = null;   // null = not yet determined
var cachedOled = null;
var lastOledCheck = 0;
var oledProtVia = null;

function rd(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch (e) { return null; }
}

function clearCache() {
  cachedOled = null;
  lastOledCheck = 0;
}

function getIsOled() {
  return isOled;
}

// As telemetry's device detection: a lost answer at start should not settle
// the panel type for the life of the process.
var MODEL_TRIES = 3;
var MODEL_RETRY_MS = 3000;

function detectOled(cb, triesLeft) {
  cb = cb || function () {};
  if (isOled !== null) return cb(isOled);
  if (triesLeft === undefined) triesLeft = MODEL_TRIES - 1;

  var forced = config.panel || (config.device && config.device.panel);
  if (forced) {
    isOled = /oled/i.test(forced);
    console.log('panel: ' + (isOled ? 'OLED' : 'not OLED') + ' (from config)');
    return cb(isOled);
  }
  if (fs.existsSync('/var/luna/preferences/paneltype_oled')) {
    isOled = true;
    console.log('panel: OLED (paneltype_oled present)');
    return cb(true);
  }
  if (!luna) return cb(false);

  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName'] },
    function (res) {
      var model = (res && res.modelName) || (config.device && config.device.model) || '';
      // "webOS TV" is the placeholder telemetry sets when it could not read one.
      if (model === 'webOS TV') model = '';
      if (!model && !(res && res.returnValue) && triesLeft > 0) {
        return setTimeout(function () { detectOled(cb, triesLeft - 1); }, MODEL_RETRY_MS);
      }
      if (model) {
        isOled = /oled/i.test(model);
        console.log('panel: ' + (isOled ? 'OLED' : 'not OLED - panel features disabled') +
                    ' (model ' + model + ')');
        return cb(isOled);
      }
      // Pixel refresher records exist only on OLED. Panel usage time is no
      // evidence either way: an LCD 50UP81006LR (webOS 6.5.0) reports it too.
      if (fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsLastTime') ||
          fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsTime')) {
        isOled = true;
        console.log('panel: OLED (detected via pnwash records)');
        return cb(true);
      }
      isOled = false;
      console.log('panel: model unknown and no OLED records - panel features disabled' +
                  ' (set "panel" in config.json to override)');
      cb(false);
    });
}

function serviceMenuState(cb) {
  var present = fs.existsSync('/usr/palm/applications/' + SERVICE_MENU_APP);
  if (!luna) {
    return cb({ ok: false, error: 'no luna wrapper' });
  }
  luna('com.webos.settingsservice/getSystemSettings',
       { category: 'other', keys: ['svcMenuFlag'] }, function (r) {
    var flag = (r && r.returnValue === true && r.settings &&
                typeof r.settings.svcMenuFlag !== 'undefined') ? r.settings.svcMenuFlag : null;
    cb({
      ok: true,
      app: present,
      lockable: flag !== null,
      locked: (flag === null) ? null : (flag === true),
      writable: config.allowControl
    });
  });
}

function setServiceMenuLock(locked, cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  luna('com.webos.settingsservice/setSystemSettings',
       { category: 'other', settings: { svcMenuFlag: !!locked } }, function (r) {
    if (!r || r.returnValue !== true) return cb({ ok: false, error: msg('srv.tvRefused', 'the TV would not change it') });
    serviceMenuState(function (st) {
      cb({ ok: st.locked === !!locked, state: st,
           error: st.locked === !!locked ? undefined : 'the setting did not take' });
    });
  });
}

function openServiceMenu(which, cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  var key = SERVICE_MENUS[which] ? which : 'ezAdjust';
  luna('com.webos.applicationManager/launch',
       { id: SERVICE_MENU_APP, params: { irKey: key } }, function (r) {
    cb({ ok: !!(r && r.returnValue), menu: key });
  });
}

function oledProtControllable() {
  return oledProtVia === 'epl' || oledProtVia === 'sysprop';
}

function readViaSysprop(cb) {
  if (!luna) return cb(null);
  luna(OLED_SYSPROP + '/getProperties', { keys: ['OledTPC', 'OledGSR'] }, function (r) {
    if (!r || r.returnValue !== true || typeof r.OledTPC === 'undefined') {
      oledProtVia = false;
      return cb(null);
    }
    oledProtVia = 'sysprop';
    cb({
      gsr: String(r.OledGSR) === 'true',
      tpc: String(r.OledTPC) === 'true',
      gsrStressCount: null
    });
  });
}

function readOledProtections(cb) {
  if (oledProtVia === 'sysprop') return readViaSysprop(cb);
  if (!luna) return cb(null);
  luna(OLED_EPL + '/getGlobalStressReduction', {}, function (gsr) {
    if (!gsr || gsr.returnValue !== true) return readViaSysprop(cb);
    luna(OLED_EPL + '/getTemporalPeakControl', {}, function (tpc) {
      oledProtVia = 'epl';
      cb({
        gsr: gsr.enable === true,
        gsrStressCount: (typeof gsr.stressCount === 'number') ? gsr.stressCount : null,
        tpc: (tpc && tpc.returnValue === true) ? tpc.enable === true : null
      });
    });
  });
}

function setOledProtection(which, enabled, cb) {
  if (which !== 'gsr' && which !== 'tpc') {
    return cb({ ok: false, error: 'unknown protection: ' + which });
  }
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });

  function afterWrite(r) {
    clearCache();
    if (!r || r.returnValue !== true) {
      return cb({ ok: false, error: msg('srv.tvRefused', 'the TV would not change it') });
    }
    readOledProtections(function (state) {
      var now = state ? (which === 'gsr' ? state.gsr : state.tpc) : null;
      cb({ ok: now === !!enabled, state: state,
           error: now === !!enabled ? undefined : 'the setting did not take' });
    });
  }

  readOledProtections(function () {
    if (oledProtVia === 'sysprop') {
      var prop = {};
      prop[which === 'gsr' ? 'OledGSR' : 'OledTPC'] = enabled ? 'true' : 'false';
      return luna(OLED_SYSPROP + '/setProperties', prop, afterWrite);
    }
    if (oledProtVia !== 'epl') {
      return cb({ ok: false, error: msg('srv.oled.notOffered', 'this TV does not offer the control') });
    }
    var method = (which === 'gsr') ? 'setGlobalStressReduction' : 'setTemporalPeakControl';
    luna(OLED_EPL + '/' + method, { enable: !!enabled }, afterWrite);
  });
}

function requestClearPanelNoise(mode, cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  luna('com.webos.service.tv.display/requestClearPanelNoise', { mode: mode }, function (r) {
    clearCache();
    cb({ ok: !!(r && r.returnValue) });
  });
}

function refreshOledStats(picSettings, pState, cb) {
  var now = Date.now();
  if (cachedOled && (now - lastOledCheck < 30000)) {
    if (picSettings) {
      if (picSettings.screenShift) cachedOled.screen_shift = picSettings.screenShift;
      if (picSettings.logoLuminanceAdjust) cachedOled.logo_dimming = picSettings.logoLuminanceAdjust;
    }
    var pnStateCached = rd('/mnt/lg/cmn_data/pnwash/state');
    var jobScopeCached = rd('/mnt/lg/cmn_data/pnwash/jobScope');
    var isPnwashRunningCached = (pnStateCached && pnStateCached.indexOf('2') === 0) || (jobScopeCached === '1');
    var isCompRunningCached = isPnwashRunningCached ||
      (pState && pState.raw === 'Active Standby' && cachedOled.hours_until_comp === 0);
    cachedOled.comp_status = isCompRunningCached ? 'Running' : 'Idle';
    cachedOled.comp_status_label = isCompRunningCached ? 'Completing Panel Maintenance (Short Cycle)' : 'Idle';
    return cb(cachedOled);
  }

  var autoPnwashRaw = rd('/mnt/lg/cmn_data/pnwash/autoPnwashTime') ||
                      rd('/mnt/lg/cmn_data/pnwash/autoJbLastTime');
  var lastRefresher = autoPnwashRaw ? parseInt(autoPnwashRaw, 10) : 0;

  var autoOffRsRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsTime') ||
                     rd('/mnt/lg/cmn_data/pnwash/autoOffRsLastTime');
  var fsLastCompHours = autoOffRsRaw ? parseInt(autoOffRsRaw, 10) : null;

  var compIntervalRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode');
  var compIntervalUnits;
  var compInterval;
  if (compIntervalRaw) {
    compIntervalUnits = parseInt(compIntervalRaw, 10);
    if (!compIntervalUnits || compIntervalUnits <= 0) compIntervalUnits = 24;
    compInterval = Math.round((compIntervalUnits * 10 / 60) * 10) / 10;
  } else {
    var compIntervalHoursRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsInterval');
    var hVal = compIntervalHoursRaw ? parseFloat(compIntervalHoursRaw) : 4;
    if (!hVal || hVal <= 0) hVal = 4;
    compInterval = hVal;
    compIntervalUnits = Math.round(hVal * 6);
  }
  if (compInterval < 0.5 || compInterval > 24) compInterval = 4;

  var autoJbIntervalRaw = rd('/mnt/lg/cmn_data/pnwash/autoJbInterval');
  var REFRESHER_INTERVAL_HOURS = autoJbIntervalRaw ? parseInt(autoJbIntervalRaw, 10) : 2000;
  if (!REFRESHER_INTERVAL_HOURS || REFRESHER_INTERVAL_HOURS <= 0) REFRESHER_INTERVAL_HOURS = 2000;

  function finishOledStats(usageUnits, lastCompUnits, dispRes) {
    var rawStatus = (dispRes && dispRes.status) ? dispRes.status : 'schedule';
    var statusStr = 'Idle';
    if (rawStatus === 'cancel_schedule') statusStr = 'Scheduled';
    else if (rawStatus === 'processing') statusStr = 'Running';

    if (usageUnits === null && fsLastCompHours !== null) {
      usageUnits = fsLastCompHours * 6;
    }

    var panelHours = (usageUnits !== null) ? Math.floor(usageUnits / 6) : 0;
    var panelHoursExact = (usageUnits !== null) ? Math.round((usageUnits * 10 / 60) * 10) / 10 : 0;

    var lastCompHours = 0;
    var hoursSinceComp = 0;
    if (lastCompUnits !== null) {
      lastCompHours = Math.round((lastCompUnits * 10 / 60) * 10) / 10;
      hoursSinceComp = (usageUnits !== null) ?
        Math.round(((usageUnits - lastCompUnits) * 10 / 60) * 10) / 10 : 0;
    } else if (fsLastCompHours !== null) {
      lastCompHours = fsLastCompHours;
      hoursSinceComp = (panelHoursExact && lastCompHours) ?
        Math.max(0, Math.round((panelHoursExact - lastCompHours) * 10) / 10) : 0;
    }
    var hoursUntilComp = Math.max(0, Math.round((compInterval - hoursSinceComp) * 10) / 10);

    var hoursSinceRefresher = (panelHours && lastRefresher) ? Math.max(0, panelHours - lastRefresher) : 0;
    var hoursUntilRefresher = Math.max(0, REFRESHER_INTERVAL_HOURS - hoursSinceRefresher);

    var offRsCountRaw = rd('/mnt/lg/cmn_data/pnwash/completedOffRsCount');
    var jbCountRaw = rd('/mnt/lg/cmn_data/pnwash/completedJbCount');
    var failAlertCountRaw = rd('/mnt/lg/cmn_data/pnwash/failAlertCount');
    var tpcOffExists = fs.existsSync('/mnt/lg/cmn_data/pnwash/tpcOff');
    var gsrOffExists = fs.existsSync('/mnt/lg/cmn_data/pnwash/gsrOff');
    var socTpcRaw = rd('/mnt/lg/cmn_data/pnwash/socTpcStatus');

    var offRsCycles = offRsCountRaw ? parseInt(offRsCountRaw, 10) : null;
    var jbCycles = jbCountRaw ? parseInt(jbCountRaw, 10) : null;
    var failCount = failAlertCountRaw ? parseInt(failAlertCountRaw, 10) : null;
    var hasTpcMonitoring = tpcOffExists || (socTpcRaw !== null) || fs.existsSync('/mnt/lg/cmn_data/pnwash/autoOffRsInterval');
    var asblStatus = hasTpcMonitoring ? ((tpcOffExists || socTpcRaw === '0') ? 'Disabled' : 'Active') : null;
    var gsrStatus = hasTpcMonitoring ? (gsrOffExists ? 'Disabled' : 'Active') : null;

    var pnStateRaw = rd('/mnt/lg/cmn_data/pnwash/state');
    var jobScopeRaw = rd('/mnt/lg/cmn_data/pnwash/jobScope');
    var isPnwashRunning = (pnStateRaw && pnStateRaw.indexOf('2') === 0) || (jobScopeRaw === '1');
    var isCompRunning = isPnwashRunning ||
      (pState && pState.raw === 'Active Standby' && hoursUntilComp === 0);
    var compStatus = isCompRunning ? 'Running' : 'Idle';
    var compStatusLabel = isCompRunning ? 'Completing Panel Maintenance (Short Cycle)' : 'Idle';

    cachedOled = {
      panel_hours: panelHours,
      panel_hours_exact: panelHoursExact,
      last_compensation_hours: lastCompHours,
      hours_since_comp: hoursSinceComp,
      hours_until_comp: hoursUntilComp,
      comp_interval_hours: compInterval,
      comp_interval_units: compIntervalUnits,
      comp_cycles: offRsCycles,
      comp_status: compStatus,
      comp_status_label: compStatusLabel,
      refresher_interval_hours: REFRESHER_INTERVAL_HOURS,
      last_refresher_hours: lastRefresher,
      hours_since_refresher: hoursSinceRefresher,
      hours_until_refresher: hoursUntilRefresher,
      refresher_cycles: jbCycles,
      refresher_status: statusStr,
      refresher_status_raw: rawStatus,
      failure_alerts: failCount,
      asbl_protection: asblStatus,
      gsr_protection: gsrStatus,
      screen_shift: (picSettings && picSettings.screenShift) ? picSettings.screenShift : 'off',
      logo_dimming: (picSettings && picSettings.logoLuminanceAdjust) ? picSettings.logoLuminanceAdjust : 'off'
    };
    lastOledCheck = Date.now();
    cb(cachedOled);
  }

  if (!luna) return cb(null);

  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['panelUsageTime', 'lastCompensationTimestamp'] },
    function (sysRes) {
      var usageUnits = (sysRes && sysRes.panelUsageTime) ? parseInt(sysRes.panelUsageTime, 10) : null;
      var lastCompUnits = (sysRes && sysRes.lastCompensationTimestamp) ? parseInt(sysRes.lastCompensationTimestamp, 10) : null;

      function queryDisplayStatus(uUnits, cUnits) {
        luna('com.webos.service.tv.display/getClearPanelNoiseStatus', {}, function (dispRes) {
          finishOledStats(uUnits, cUnits, dispRes);
        });
      }

      if (usageUnits !== null) {
        queryDisplayStatus(usageUnits, lastCompUnits);
      } else {
        luna('com.webos.service.panelcontroller/getPanelUsageTime', { subscribe: false }, function (pcRes) {
          if (pcRes && pcRes.panelUsageTime) {
            usageUnits = parseInt(pcRes.panelUsageTime, 10);
          }
          queryDisplayStatus(usageUnits, lastCompUnits);
        });
      }
    }
  );
}

function readPanelControllerInfo(cb) {
  if (!luna) return cb(null);
  luna('com.webos.service.panelcontroller/getOledCellInfo', {}, function (cellRes) {
    var out = {
      cell: (cellRes && cellRes.cellInfo) ? cellRes.cellInfo : null,
      tconFirmware: null,
      tconModule: null
    };
    luna('com.webos.service.panelcontroller/getOledTconInfo', {}, function (tconRes) {
      if (tconRes && tconRes.tconParamForInstart) {
        out.tconFirmware = tconRes.tconParamForInstart.tconFpgaFirmwareVer || null;
        out.tconModule = tconRes.tconParamForInstart.tconModuleInfo || null;
      }
      cb(out);
    });
  });
}

function init(opts) {
  opts = opts || {};
  if (opts.luna) luna = opts.luna;
  if (opts.config) config = opts.config;
}

module.exports = {
  init: init,
  detectOled: detectOled,
  getIsOled: getIsOled,
  serviceMenuState: serviceMenuState,
  setServiceMenuLock: setServiceMenuLock,
  openServiceMenu: openServiceMenu,
  oledProtControllable: oledProtControllable,
  readOledProtections: readOledProtections,
  setOledProtection: setOledProtection,
  refreshOledStats: refreshOledStats,
  requestClearPanelNoise: requestClearPanelNoise,
  readPanelControllerInfo: readPanelControllerInfo,
  clearCache: clearCache
};
