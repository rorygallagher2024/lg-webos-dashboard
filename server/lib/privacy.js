// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var fs = require('fs');
var execFile = require('child_process').execFile;

var ADBLOCK_HOSTS_FILE = '/var/lib/tvweb/adblock_hosts';
var ADBLOCK_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-mqtt)';
var ADBLOCK_FLAG_FILE = '/var/lib/tvweb/adblock_enabled';

var ADBLOCK_ADS = [
  'ad.lgsmartad.com',
  'ibis.lgappstv.com',
  'ibs.lgappstv.com',
  'lgsmartad.com',
  'rdx.lgtvcommon.com',
  'aic.lgtvcommon.com',
  'smartclip.com',
  'smartclip-services.com',
  'yumenetworks.com'
];

var ADBLOCK_PLATFORM = [
  'lgtvsdp.com',
  'us.lgtvsdp.com',
  'gb.lgtvsdp.com',
  'eu.lgtvsdp.com',
  'nextlgsdp.com',
  'us.nextlgsdp.com',
  'gb.nextlgsdp.com',
  'eu.nextlgsdp.com',
  'ngfts.lge.com',
  'aic-ngfts.lge.com'
];

var ADBLOCK_DOMAINS = ADBLOCK_ADS.concat(ADBLOCK_PLATFORM);

/*
 * The Homebrew Channel blackholes LG's update servers when its own flag file is
 * there, in a table it bind-mounts at boot - and it does that before running the
 * hooks that mount this one over the top (its startup.sh blocks at line 62 and
 * runs run-parts at 136). Switching this blocker on would otherwise switch its
 * update blocking off, silently, so its hosts go into this table too.
 */
var HBC_BLOCK_UPDATES_FLAG = '/var/luna/preferences/webosbrew_block_updates';
var HBC_UPDATE_HOSTS = ['snu.lge.com', 'su-dev.lge.com', 'su.lge.com', 'su-ssl.lge.com'];

var CONSENT_LABELS = {
  acrAllowed:              ['Screen content recognition', 'Lets LG identify what is on your screen to profile your viewing'],
  acrGdprAllowed:          ['Screen recognition (GDPR consent)', 'The EU consent record for screen content recognition'],
  acrAdAllowed:            ['Ads based on what you watch', 'Uses recognised screen content to target advertising'],
  customAdAllowed:         ['Personalised advertising', 'Tailors the ads shown on your TV to you'],
  customadsAllowed:        ['Personalised advertising (secondary flag)', 'A second personalised-advertising consent record'],
  cookiesAllowed:          ['Advertising cookies', 'Stores cookies used for ad tracking'],
  thirdPartySharingAllowed:['Sharing your data with other companies', 'Passes your usage data to third parties'],
  additionalDataAllowed:   ['Additional usage data', 'Extra analytics beyond what the TV needs to work'],
  remoteDiagAllowed:       ['Remote diagnostics upload', 'Lets LG collect and upload diagnostic reports from your TV'],
  voiceAllowed:            ['Voice recordings', 'Allows voice data to be collected and processed'],
  voice2Allowed:           ['Voice recordings (secondary flag)', 'A second voice-data consent record']
};

var CONSENT_LOCKED = {
  generalTermsAllowed: 'Acceptance of the terms themselves.',
  networkAllowed:      'Acceptance of network use.',
  firstUseAllowed:     'Part of first-boot setup.',
  allAllowed:          'The Select-All. Read-only because whether writing it cascades to the ' +
                       'other flags is untested.'
};

var CONSENT_GROUPS = [
  ['advertising', 'Advertising'],
  ['watching',    'What the TV watches and hears'],
  ['analytics',   'Analytics and sharing'],
  ['services',    'LG services'],
  ['unknown',     'No published description',
   'The TV records these and LG publishes nothing about what they mean. ' +
   'The ones it cannot tie to any agreement are left read-only.'],
  ['platform',    'Set on the TV itself',
   'Acceptance records rather than collection choices. Changed in the TV\'s own menus, ' +
   'under Settings \u203a General \u203a About This TV \u203a User Agreements.']
];

var CONSENT_GROUP_OF = {
  customAdAllowed: 'advertising',
  customadsAllowed: 'advertising',
  cookiesAllowed: 'advertising',
  acrAdAllowed: 'advertising',

  acrAllowed: 'watching',
  acrGdprAllowed: 'watching',
  voiceAllowed: 'watching',
  voice2Allowed: 'watching',

  additionalDataAllowed: 'analytics',
  remoteDiagAllowed: 'analytics',
  thirdPartySharingAllowed: 'analytics',

  acrOnAllowed: 'watching',
  marketingOnAllowed: 'advertising',
  chpAllowed: 'services',
  shoppingOnAllowed: 'services',

  networkAllowed: 'platform',
  generalTermsAllowed: 'platform',
  firstUseAllowed: 'platform',
  allAllowed: 'platform'
};

var CONSENT_NAMES = {
  networkAllowed:      'Network use',
  marketingOnAllowed:  'Marketing',
  shoppingOnAllowed:   'Shopping',
  generalTermsAllowed: 'Terms of Use and Privacy Policy',
  chpAllowed:          'LG Channels',
  acrOnAllowed:        'Screen recognition (master consent)',
  allAllowed:          'Select All'
};

var PRIVACY_DAEMONS = {
  acr2:       ['Content recognition service', 'Identifies what is on screen', 'bus'],
  admanager:  ['Advertising service', 'Fetches and displays ads on the TV', 'bus'],
  uploadd:    ['Diagnostics uploader', 'Sends diagnostic data to LG', 'upstart'],
  rdxd:       ['Diagnostics collector', 'Gathers crash and diagnostic reports', 'upstart']
};

var SERVICES_FILE = '/var/lib/tvweb/services_stopped';
var SERVICE_CONTROLLABLE = { uploadd: true, rdxd: true };

var luna = null;
var lunaCached = null;
var config = {};
var cachedAdBlockActive = null;
var lastAdBlockCheck = 0;
var cachedPrivacy = null;
var lastPrivacyCheck = 0;
var consentGroups = null;
var consentMapFound = false;

function rd(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch (e) { return null; }
}

function clearCache() {
  cachedPrivacy = null;
  cachedAdBlockActive = null;
}

function storeHost() {
  try {
    var j = JSON.parse(rd('/var/palm/data/com.webos.appInstallService/serverInfo') || '{}');
    var m = /^[a-z]+:\/\/([^\/:?#]+)/i.exec(String(j.serverUrl || ''));
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}

function adBlockPlatform() {
  var list = ADBLOCK_PLATFORM.slice();
  var host = storeHost();
  if (host && list.indexOf(host) === -1) list.push(host);
  return list;
}

function adBlockList(mode) {
  return mode === 'full' ? ADBLOCK_ADS.concat(adBlockPlatform()) : ADBLOCK_ADS;
}

function isAdBlockActive() {
  var now = Date.now();
  if (cachedAdBlockActive !== null && (now - lastAdBlockCheck < 30000)) {
    return cachedAdBlockActive;
  }
  try {
    var hosts = fs.readFileSync('/etc/hosts', 'utf8');
    cachedAdBlockActive = hosts.indexOf(ADBLOCK_MARKER) !== -1;
    lastAdBlockCheck = now;
    return cachedAdBlockActive;
  } catch (e) {
    return false;
  }
}

function adBlockMode() {
  if (!isAdBlockActive()) return 'off';
  var flag = rd(ADBLOCK_FLAG_FILE);
  return flag === 'ads' ? 'ads' : 'full';
}

// Both families for every name. A sinkhole with no AAAA record leaves the
// resolver to ask DNS for one, and the connection goes through on IPv6.
function sinkhole(lines, host) {
  lines.push('0.0.0.0\t' + host);
  lines.push('::\t' + host);
}

function adBlockHostsTable(mode) {
  var list = adBlockList(mode);
  var lines = [
    '127.0.0.1\tlocalhost.localdomain\tlocalhost',
    '::1\tlocalhost ip6-localhost ip6-loopback',
    'fe00::0\tip6-localnet',
    'ff00::0\tip6-mcastprefix',
    'ff02::1\tip6-allnodes',
    'ff02::2\tip6-allrouters',
    '',
    ADBLOCK_MARKER
  ];
  for (var i = 0; i < list.length; i++) sinkhole(lines, list[i]);
  if (fs.existsSync(HBC_BLOCK_UPDATES_FLAG)) {
    lines.push('', '# Blocked by the Homebrew Channel; kept so this table does not undo it');
    for (var u = 0; u < HBC_UPDATE_HOSTS.length; u++) sinkhole(lines, HBC_UPDATE_HOSTS[u]);
  }
  lines.push('');
  return lines.join('\n');
}

function setAdBlock(mode, cb) {
  var active = isAdBlockActive();
  if (mode !== 'off') {
    try {
      fs.writeFileSync(ADBLOCK_HOSTS_FILE, adBlockHostsTable(mode), 'utf8');
      fs.writeFileSync(ADBLOCK_FLAG_FILE, mode, 'utf8');
    } catch (e) {
      if (cb) cb({ ok: false, error: 'could not write adblock hosts: ' + e.message });
      return;
    }
    if (active) {
      clearCache();
      if (cb) cb({ ok: true, enabled: true, mode: mode });
      return;
    }
    execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
      clearCache();
      if (cb) cb({ ok: !err, enabled: isAdBlockActive(), mode: adBlockMode() });
    });
  } else if (mode === 'off' && active) {
    try {
      if (fs.existsSync(ADBLOCK_FLAG_FILE)) fs.unlinkSync(ADBLOCK_FLAG_FILE);
    } catch (e) {}
    execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function (err) {
      clearCache();
      if (cb) cb({ ok: !err, enabled: isAdBlockActive(), mode: adBlockMode() });
    });
  } else {
    if (cb) cb({ ok: true, enabled: active, mode: adBlockMode() });
  }
}

function checkBootAdBlock(cliMode) {
  if (cliMode) return;
  try {
    if (fs.existsSync(ADBLOCK_FLAG_FILE) && !isAdBlockActive() && fs.existsSync(ADBLOCK_HOSTS_FILE)) {
      execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
        clearCache();
        if (!err) console.log('adblock: restored /etc/hosts bind-mount from previous boot');
      });
    }
  } catch (e) {}
}

function loadConsentGroups() {
  if (consentGroups) return consentGroups;
  consentGroups = {};
  try {
    var j = JSON.parse(rd('/var/palm/license/eulaInfoNetwork.json') || '{}');
    var list = (j.eulaMappingList && j.eulaMappingList.eulaInfo) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.settingKey) continue;
      consentGroups[e.settingKey] = (e.mandatory || e.generalSelectAll || []).slice().sort();
      consentMapFound = true;
    }
  } catch (err) {}
  return consentGroups;
}

function readConsentDocs(cb) {
  if (!luna) return cb(null);
  luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, function (r) {
    var eln = r && r.settings && r.settings.eulaInfoNetwork;
    cb(eln && Array.isArray(eln.eulaList) ? eln : null);
  });
}

function acceptedSet(eln) {
  var out = {};
  for (var i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].accepted) out[eln.eulaList[i].id] = true;
  }
  return out;
}

function docsSatisfied(need, accepted) {
  for (var i = 0; i < need.length; i++) if (!accepted[need[i]]) return false;
  return need.length > 0;
}

function planConsent(key, on, flags, eln) {
  var groups = loadConsentGroups();
  var accepted = acceptedSet(eln);
  var need = groups[key] || [];
  var i, k;

  if (on) {
    for (i = 0; i < need.length; i++) accepted[need[i]] = true;
  } else {
    var protectedDocs = {};
    for (k in groups) {
      if (!groups.hasOwnProperty(k)) continue;
      if (!CONSENT_LOCKED[k] || !flags[k]) continue;
      for (i = 0; i < groups[k].length; i++) protectedDocs[groups[k][i]] = true;
    }
    for (i = 0; i < need.length; i++) {
      if (!protectedDocs[need[i]]) delete accepted[need[i]];
    }
  }

  var nextFlags = {}, changed = [];
  for (k in flags) if (flags.hasOwnProperty(k)) nextFlags[k] = flags[k];
  for (k in groups) {
    if (!groups.hasOwnProperty(k) || !nextFlags.hasOwnProperty(k)) continue;
    if (CONSENT_LOCKED[k]) continue;
    if (nextFlags[k] && !docsSatisfied(groups[k], accepted)) {
      nextFlags[k] = false;
      changed.push(k);
    }
  }
  if (nextFlags[key] !== on) { nextFlags[key] = on; if (changed.indexOf(key) === -1) changed.push(key); }

  var nextDocs = JSON.parse(JSON.stringify(eln));
  for (i = 0; i < nextDocs.eulaList.length; i++) {
    nextDocs.eulaList[i].accepted = !!accepted[nextDocs.eulaList[i].id];
  }
  return { flags: nextFlags, docs: nextDocs, changed: changed };
}

function consentSettable(key) {
  if (CONSENT_LOCKED[key]) return false;
  if (CONSENT_LABELS[key]) return true;
  return !!loadConsentGroups()[key];
}

function consentPeers(key, groups) {
  var mine = groups[key], names = [];
  if (!mine || !mine.length) return names;
  for (var other in groups) {
    if (!groups.hasOwnProperty(other) || other === key) continue;
    if (!CONSENT_LABELS[other]) continue;
    if (groups[other].join(',') === mine.join(',')) names.push('"' + CONSENT_LABELS[other][0] + '"');
  }
  return names;
}

function consentGroup(key) {
  return CONSENT_GROUP_OF[key] || 'unknown';
}

function describeUnlabelled(key, on, groups) {
  var row = { key: key, enabled: on, settable: consentSettable(key), group: consentGroup(key) };
  if (CONSENT_NAMES[key]) row.label = CONSENT_NAMES[key];
  var docs = groups[key];
  if (docs) row.documents = docs;
  if (CONSENT_LOCKED[key]) {
    row.detail = CONSENT_LOCKED[key];
    return row;
  }
  if (!docs) {
    row.detail = consentMapFound
      ? 'Tied to no agreement on this firmware.'
      : 'This TV publishes no agreement mapping, so there is nothing to go on.';
    return row;
  }
  var peers = consentPeers(key, groups);
  row.detail = peers.length
    ? 'Accepted under the same agreement as ' + peers.join(' and ') + '.'
    : 'Filed under an agreement the TV does not name.';
  return row;
}

function annotateConsent(consent, eln) {
  if (!consent || !eln) return;
  var titles = {}, i;
  for (i = 0; i < eln.eulaList.length; i++) {
    if (eln.eulaList[i].title) titles[eln.eulaList[i].id] = eln.eulaList[i].title;
  }
  var groups = loadConsentGroups();
  var rows = (consent.known || []).concat(consent.other || []);
  var flags = {}, byKey = {};
  for (i = 0; i < rows.length; i++) { flags[rows[i].key] = rows[i].enabled; byKey[rows[i].key] = rows[i]; }

  for (i = 0; i < rows.length; i++) {
    var row = rows[i], need = groups[row.key];
    if (!need) continue;
    var names = [];
    for (var j = 0; j < need.length; j++) if (titles[need[j]]) names.push(titles[need[j]]);
    if (names.length) {
      row.agreements = names;
      if (!CONSENT_LABELS[row.key]) {
        row.detail = 'Accepted under ' + (names.length > 1
          ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
          : names[0]) + '.';
      }
    }
    if (!row.settable || !row.enabled) continue;
    var plan = planConsent(row.key, false, flags, eln);
    var also = [];
    for (var c = 0; c < plan.changed.length; c++) {
      var k = plan.changed[c];
      if (k === row.key || !byKey[k]) continue;
      also.push(byKey[k].label || k);
    }
    if (also.length) row.sharesWith = also;
  }
}

function readConsentFlags() {
  var raw = rd('/var/luna/preferences/eula');
  if (!raw) return null;
  var groups = loadConsentGroups();
  var out = { known: [], other: [] };
  var re = /"([a-zA-Z0-9_]+Allowed)"\s*:\s*(true|false)/g, m;
  while ((m = re.exec(raw)) !== null) {
    var key = m[1], on = m[2] === 'true';
    if (CONSENT_LABELS[key]) {
      out.known.push({ key: key, label: CONSENT_LABELS[key][0], detail: CONSENT_LABELS[key][1],
                       enabled: on, settable: consentSettable(key),
                       group: consentGroup(key) });
    } else {
      out.other.push(describeUnlabelled(key, on, groups));
    }
  }
  return out;
}

function stoppedServices() {
  var raw = rd(SERVICES_FILE), out = [];
  if (!raw) return out;
  var parts = raw.split('\n');
  for (var i = 0; i < parts.length; i++) {
    var n = parts[i].replace(/\s+/g, '');
    if (n && SERVICE_CONTROLLABLE[n] && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

function upstartJobs(cb) {
  execFile('/sbin/initctl', ['list'], { timeout: 4000 }, function (err, stdout) {
    var out = {}, lines = String(stdout || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\S+)\s+(\S+)/.exec(lines[i]);
      if (m) out[m[1]] = m[2].replace(/,$/, '');
    }
    cb(out);
  });
}

function setServiceEnabled(name, enable, cb) {
  execFile('/sbin/initctl', [enable ? 'start' : 'stop', name], { timeout: 6000 }, function () {
    upstartJobs(function (jobs) {
      var running = String(jobs[name] || '').indexOf('start/') === 0;
      var list = stoppedServices(), at = list.indexOf(name);
      if (enable && at !== -1) list.splice(at, 1);
      if (!enable && at === -1) list.push(name);
      try {
        if (list.length) fs.writeFileSync(SERVICES_FILE, list.join('\n') + '\n', 'utf8');
        else if (fs.existsSync(SERVICES_FILE)) fs.unlinkSync(SERVICES_FILE);
      } catch (e) {}
      clearCache();
      console.log('service: ' + name + ' -> ' + (enable ? 'start' : 'stop') +
                  (running === enable ? '' : ' (did not take)'));
      cb(running === enable
        ? { ok: true, name: name, running: running }
        : { ok: false, error: 'the TV did not ' + (enable ? 'start' : 'stop') + ' ' + name });
    });
  });
}

function runningDaemons(cb) {
  var held = stoppedServices();
  upstartJobs(function (jobs) {
    execFile('/bin/ps', ['-eo', 'args'], { timeout: 4000 }, function (err, stdout) {
      var txt = String(stdout || ''), list = [];
      for (var name in PRIVACY_DAEMONS) {
        if (!PRIVACY_DAEMONS.hasOwnProperty(name)) continue;
        var d = PRIVACY_DAEMONS[name];
        var onDemand = d[2] === 'bus';
        list.push({
          name: name,
          label: d[0],
          detail: d[1],
          running: txt.indexOf('/usr/sbin/' + name) !== -1,
          onDemand: onDemand,
          job: jobs[name] || null,
          stoppable: !onDemand && !!SERVICE_CONTROLLABLE[name] && !!jobs[name],
          heldDown: held.indexOf(name) !== -1
        });
      }
      cb(list);
    });
  });
}

function collectPrivacy(cb) {
  var now = Date.now();
  if (cachedPrivacy && (now - lastPrivacyCheck < 20000)) return cb(cachedPrivacy);

  var out = { ok: true, consent: readConsentFlags(), consentWritable: config.allowControl,
              consentGroups: CONSENT_GROUPS };

  runningDaemons(function (daemons) {
    out.daemons = daemons;
    var lunaFn = lunaCached || luna;
    lunaFn('com.webos.settingsservice/getSystemSettings', { keys: ['eulaInfoNetwork'] }, 60000,
           function (elnRes) {
      var eln = elnRes && elnRes.settings && elnRes.settings.eulaInfoNetwork;
      if (eln && Array.isArray(eln.eulaList)) annotateConsent(out.consent, eln);
      luna('com.webos.service.acr/getACRSolutionStatus', {}, function (acr) {
        out.acr = {
          label: 'Screen content recognition',
          detail: 'LG calls this ACR. It samples what is on screen to work out what you are watching.',
          active: !!(acr && acr.ACRSolutionStatus)
        };
        luna('com.webos.service.acr/getVideoCaptureStatus', {}, function (cap) {
          out.acr.capturing = !!(cap && cap.status && cap.status !== 'stopped');
          out.acr.captureState = (cap && cap.status) ? cap.status : 'unknown';
          luna('com.webos.service.admanager/getAdid', {}, function (ad) {
            var adOk = !!(ad && ad.returnValue !== false && ad.IFA !== undefined);
            var id = (adOk && ad.IFA) ? String(ad.IFA) : null;
            out.advertisingId = {
              available: adOk,
              label: 'Advertising identifier',
              detail: 'A unique ID your TV hands to advertisers. Resetting it breaks the link to your past activity.',
              present: !!id,
              limitTracking: !!(ad && String(ad.LMT).toLowerCase() === 'on'),
              limitTrackingLabel: 'Limit ad tracking',
              limitTrackingDetail: 'When on, apps are asked not to use this ID to profile you.'
            };
            out.adblock = {
              enabled: isAdBlockActive(),
              mode: adBlockMode(),
              count: adBlockList('full').length,
              adCount: ADBLOCK_ADS.length,
              platform: adBlockPlatform()
            };
            cachedPrivacy = out;
            lastPrivacyCheck = Date.now();
            cb(out);
          });
        });
      });
    });
  });
}

function resetAdId(cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  luna('com.webos.service.admanager/getAdid', {}, function (before) {
    var was = (before && before.IFA) ? String(before.IFA) : null;
    luna('com.webos.service.admanager/resetIFA', {}, function (r) {
      luna('com.webos.service.admanager/getAdid', {}, function (after) {
        var now = (after && after.IFA) ? String(after.IFA) : null;
        clearCache();
        cb({
          ok: !!(r && r.returnValue !== false),
          changed: !!(was && now && was !== now)
        });
      });
    });
  });
}

function clearAdCookies(cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  luna('com.webos.service.admanager/inactivateCookies', {}, function (r) {
    clearCache();
    cb({ ok: !!(r && r.returnValue !== false) });
  });
}

function setConsent(ckey, cOn, cb) {
  if (!ckey) return cb({ ok: false, error: 'no consent flag named' });
  if (!consentSettable(ckey)) return cb({ ok: false, error: ckey + ' is not changeable from here' });
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });

  luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (r) {
    var cur = r && r.settings && r.settings.eulaStatus;
    if (!cur || typeof cur !== 'object') return cb({ ok: false, error: 'could not read the consent flags' });
    if (!cur.hasOwnProperty(ckey)) return cb({ ok: false, error: 'no such consent flag: ' + ckey });

    readConsentDocs(function (eln) {
      if (!eln) return cb({ ok: false, error: 'could not read the agreement documents' });
      var plan = planConsent(ckey, cOn, cur, eln);
      if (!plan.changed.length) {
        clearCache();
        return cb({ ok: true, key: ckey, enabled: cOn, changed: false });
      }
      luna('com.webos.settingsservice/setSystemSettings',
           { settings: { eulaInfoNetwork: plan.docs, eulaStatus: plan.flags } }, function (w) {
        clearCache();
        if (!(w && w.returnValue)) {
          console.log('consent: ' + ckey + ' -> ' + cOn + ' (refused)');
          return cb({ ok: false, error: (w && w.errorText) || 'the TV refused the change' });
        }
        luna('com.webos.settingsservice/getSystemSettings', { keys: ['eulaStatus'] }, function (v) {
          var now = v && v.settings && v.settings.eulaStatus;
          var applied = !!(now && now[ckey] === cOn);
          console.log('consent: ' + ckey + ' ' + cur[ckey] + ' -> ' + cOn +
                      (plan.changed.length > 1 ? ' (with ' + (plan.changed.length - 1) + ' sharing the agreement)' : '') +
                      (applied ? '' : ' (accepted but not applied)'));
          cb(applied
            ? { ok: true, key: ckey, enabled: cOn, changed: true, alsoChanged: plan.changed.length - 1 }
            : { ok: false, error: 'the TV accepted the change without applying it' });
        });
      });
    });
  });
}

function init(opts) {
  opts = opts || {};
  if (opts.luna) luna = opts.luna;
  if (opts.lunaCached) lunaCached = opts.lunaCached;
  if (opts.config) config = opts.config;
}

module.exports = {
  init: init,
  isAdBlockActive: isAdBlockActive,
  adBlockMode: adBlockMode,
  adBlockPlatform: adBlockPlatform,
  adBlockList: adBlockList,
  setAdBlock: setAdBlock,
  checkBootAdBlock: checkBootAdBlock,
  resetAdId: resetAdId,
  clearAdCookies: clearAdCookies,
  collectPrivacy: collectPrivacy,
  setConsent: setConsent,
  setServiceEnabled: setServiceEnabled,
  readConsentFlags: readConsentFlags,
  clearCache: clearCache,
  ADBLOCK_ADS: ADBLOCK_ADS,
  ADBLOCK_PLATFORM: ADBLOCK_PLATFORM,
  ADBLOCK_DOMAINS: ADBLOCK_DOMAINS,
  adBlockHostsTable: adBlockHostsTable,
  CONSENT_LABELS: CONSENT_LABELS,
  CONSENT_LOCKED: CONSENT_LOCKED,
  CONSENT_GROUPS: CONSENT_GROUPS
};
