// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;
var fs = require('fs');
var execFile = require('child_process').execFile;

var ADBLOCK_HOSTS_FILE = '/var/lib/tvweb/adblock_hosts';
var ADBLOCK_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-dashboard)';
var ADBLOCK_LEGACY_MARKER = '# LG Ad & Telemetry Blackhole (lg-webos-mqtt)';
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
  'yumenetworks.com',
  // Alphonso is LG Ad Solutions' screen recognition (ACR) service. The TV asks
  // prov-lg for its setup and eulacheck for consent before anything else.
  'alphonso.tv',
  'prov-lg.alphonso.tv',
  'prov.alphonso.tv',
  'eulacheck.alphonso.tv',
  'bl-server.alphonso.tv',
  'clockskew.alphonso.tv',
  'acrdb.alphonso.tv',
  'ads.alphonso.tv',
  'api.alphonso.tv',
  'tvads.alphonso.tv',
  'sync.alphonso.tv',
  'tr.alphonso.tv',
  'tn.alphonso.tv',
  'insights.alphonso.tv',
  'bwlkup.alphonso.tv'
];

/*
 * The firmware builds these names with a prefix (gb.info.lgsmartad.com,
 * aic.cdpbeacon.lgtvcommon.com), and a hosts file only matches whole names. A
 * TV uses its own country code and LG's regional ones, so those are listed
 * rather than every country, which would cost the B8 ~4ms a lookup (74KB
 * table). The bare lgtvsdp.com family also serves the Content Store, which is
 * why only its rdx2 ad subdomain is here.
 */
var ADBLOCK_REGIONAL = [
  'info.lgsmartad.com',
  'rdx2.lgtvsdp.com',
  'ibs.lgappstv.com',
  'ibsstat.lgappstv.com',
  'cdpbeacon.lgtvcommon.com',
  'cdpsvc.lgtvcommon.com',
  'wau.lgtvcommon.com'
];
var ADBLOCK_REGION_PREFIXES = ['aic', 'eic', 'kic', 'eu'];
// Until the TV has reported its country, the countries LG is seen using.
var ADBLOCK_FALLBACK_COUNTRIES = ['us', 'gb', 'au', 'br', 'ca', 'de', 'fr'];
var COUNTRY_FILE = '/var/lib/tvweb/country';

function adBlockAds() {
  var country = (rd(COUNTRY_FILE) || '').toLowerCase();
  var prefixes = ADBLOCK_REGION_PREFIXES.concat(/^[a-z]{2}$/.test(country) ? [country] : ADBLOCK_FALLBACK_COUNTRIES);
  var list = ADBLOCK_ADS.slice();
  ADBLOCK_REGIONAL.forEach(function (name) {
    [name].concat(prefixes.map(function (p) { return p + '.' + name; }))
      .forEach(function (h) { if (list.indexOf(h) === -1) list.push(h); });
  });
  return list;
}

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
  acrAllowed:              [msg('srv.consent.acrAllowed', 'Screen content recognition'), msg('srv.consent.acrAllowed.detail', 'Lets LG identify what is on your screen to profile your viewing')],
  acrGdprAllowed:          [msg('srv.consent.acrGdprAllowed', 'Screen recognition (GDPR consent)'), msg('srv.consent.acrGdprAllowed.detail', 'The EU consent record for screen content recognition')],
  acrAdAllowed:            [msg('srv.consent.acrAdAllowed', 'Ads based on what you watch'), msg('srv.consent.acrAdAllowed.detail', 'Uses recognised screen content to target advertising')],
  customAdAllowed:         [msg('srv.consent.customAdAllowed', 'Personalised advertising'), msg('srv.consent.customAdAllowed.detail', 'Tailors the ads shown on your TV to you')],
  customadsAllowed:        [msg('srv.consent.customadsAllowed', 'Personalised advertising (secondary flag)'), msg('srv.consent.customadsAllowed.detail', 'A second personalised-advertising consent record')],
  cookiesAllowed:          [msg('srv.consent.cookiesAllowed', 'Advertising cookies'), msg('srv.consent.cookiesAllowed.detail', 'Stores cookies used for ad tracking')],
  thirdPartySharingAllowed:[msg('srv.consent.thirdPartySharingAllowed', 'Sharing your data with other companies'), msg('srv.consent.thirdPartySharingAllowed.detail', 'Passes your usage data to third parties')],
  additionalDataAllowed:   [msg('srv.consent.additionalDataAllowed', 'Additional usage data'), msg('srv.consent.additionalDataAllowed.detail', 'Extra analytics beyond what the TV needs to work')],
  remoteDiagAllowed:       [msg('srv.consent.remoteDiagAllowed', 'Remote diagnostics upload'), msg('srv.consent.remoteDiagAllowed.detail', 'Lets LG collect and upload diagnostic reports from your TV')],
  voiceAllowed:            [msg('srv.consent.voiceAllowed', 'Voice recordings'), msg('srv.consent.voiceAllowed.detail', 'Allows voice data to be collected and processed')],
  voice2Allowed:           [msg('srv.consent.voice2Allowed', 'Voice recordings (secondary flag)'), msg('srv.consent.voice2Allowed.detail', 'A second voice-data consent record')]
};

var CONSENT_LOCKED = {
  generalTermsAllowed: msg('srv.consent.locked.generalTerms', 'Acceptance of the terms themselves.'),
  networkAllowed:      msg('srv.consent.locked.network', 'Acceptance of network use.'),
  firstUseAllowed:     msg('srv.consent.locked.firstUse', 'Part of first-boot setup.'),
  allAllowed:          msg('srv.consent.locked.all', 'The Select-All. Read-only because whether writing it cascades to the other flags is untested.')
};

var CONSENT_GROUPS = [
  ['advertising', msg('srv.consent.group.advertising', 'Advertising')],
  ['watching',    msg('srv.consent.group.watching', 'What the TV watches and hears')],
  ['analytics',   msg('srv.consent.group.analytics', 'Analytics and sharing')],
  ['services',    msg('srv.consent.group.services', 'LG services')],
  ['unknown',     msg('srv.consent.group.unknown', 'No published description'),
   msg('srv.consent.group.unknown.note', 'The TV records these, but LG publishes nothing about them.')],
  ['platform',    msg('srv.consent.group.platform', 'Set on the TV itself'),
   msg('srv.consent.group.platform.note', 'Acceptance records rather than collection choices. Changed in the TV\'s own menus, under Settings \u203a General \u203a About This TV \u203a User Agreements.')]
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
  shoppingOnAllowed: 'advertising',

  networkAllowed: 'platform',
  generalTermsAllowed: 'platform',
  firstUseAllowed: 'platform',
  allAllowed: 'platform'
};

/*
 * Flags LG leaves unnamed, known by the agreement their mapping requires. By
 * agreement rather than by key, since which numbered slot LG uses for what can
 * differ by region: on UK firmware additional1Allowed maps to the Data
 * Partners Agreement, and acr2 reads it, logging it as "DPA". takeOnAllowed
 * maps to S_TAK, the Who.Where.What? agreement run with TheTake, and livepick
 * reads it. marketingOnAllowed maps to S_MKT and is read by sdx, which sends
 * the accepted terms to LG.
 */
var CONSENT_BY_DOCUMENT = {
  S_DPA: [msg('srv.consent.dpa', 'Sharing viewing data with data partners'),
          msg('srv.consent.dpa.detail', 'Lets LG and Alphonso, its screen recognition partner, pass viewing and device information to other companies for ad measurement and analytics'), 'analytics'],
  S_TAK: ['Who.Where.What?',
          msg('srv.consent.tak.detail', 'LG\'s content discovery, run with TheTake: identifies people, places and products in what is on screen, using viewing information that can include captured images of it'), 'watching'],
  S_MKT: [msg('srv.consent.mkt', 'Marketing messages'),
          msg('srv.consent.mkt.detail', 'Lets LG show marketing pop-ups and notifications on the TV: special offers and news about its content and services'), 'advertising']
};

// Named from what reads them, where no agreement of their own names them.
// adoverlay-service, which places ads over live TV, reads shoppingOnAllowed
// with customadsAllowed and acrOnAllowed.
var CONSENT_READ_BY = {
  shoppingOnAllowed: msg('srv.consent.shoppingOn.detail', 'Read by the service that places ads and offers over live TV, alongside personalised advertising')
};

function consentByDocument(key) {
  if (CONSENT_LOCKED[key]) return null;
  var docs = loadConsentGroups()[key] || [];
  for (var i = 0; i < docs.length; i++) if (CONSENT_BY_DOCUMENT[docs[i]]) return CONSENT_BY_DOCUMENT[docs[i]];
  return null;
}

var CONSENT_NAMES = {
  networkAllowed:      msg('srv.consent.name.networkAllowed', 'Network use'),
  marketingOnAllowed:  msg('srv.consent.name.marketingOnAllowed', 'Marketing'),
  shoppingOnAllowed:   msg('srv.consent.name.shoppingOnAllowed', 'Shopping on live TV'),
  generalTermsAllowed: msg('srv.consent.name.generalTermsAllowed', 'Terms of Use and Privacy Policy'),
  chpAllowed:          'LG Channels',
  acrOnAllowed:        msg('srv.consent.name.acrOnAllowed', 'Screen recognition (master consent)'),
  allAllowed:          msg('srv.consent.name.allAllowed', 'Select All')
};

var PRIVACY_DAEMONS = {
  acr2:       [msg('srv.daemon.acr2', 'Content recognition service'), msg('srv.daemon.acr2.detail', 'Identifies what is on screen'), 'bus'],
  admanager:  [msg('srv.daemon.admanager', 'Advertising service'), msg('srv.daemon.admanager.detail', 'Fetches and displays ads on the TV'), 'bus'],
  uploadd:    [msg('srv.daemon.uploadd', 'Diagnostics uploader'), msg('srv.daemon.uploadd.detail', 'Sends diagnostic data to LG'), 'upstart'],
  rdxd:       [msg('srv.daemon.rdxd', 'Diagnostics collector'), msg('srv.daemon.rdxd.detail', 'Gathers crash and diagnostic reports'), 'upstart']
};

var SERVICES_FILE = '/var/lib/tvweb/services_stopped';
var SERVICE_CONTROLLABLE = { uploadd: true, rdxd: true };

var luna = null;
var lunaCached = null;
var config = {};
var cachedAdBlockActive = null;
var lastAdBlockCheck = 0;
var cachedPrivacy = null;
var lgSettingsModule = null;
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
  if (mode === 'off') return [];
  return mode === 'full' ? adBlockAds().concat(adBlockPlatform()) : adBlockAds();
}

// Whether this server's table is over /etc/hosts, for ads, updates or both.
function isTableMounted() {
  var now = Date.now();
  if (cachedAdBlockActive !== null && (now - lastAdBlockCheck < 30000)) {
    return cachedAdBlockActive;
  }
  try {
    var hosts = fs.readFileSync('/etc/hosts', 'utf8');
    cachedAdBlockActive = hosts.indexOf(ADBLOCK_MARKER) !== -1 || hosts.indexOf(ADBLOCK_LEGACY_MARKER) !== -1;
    lastAdBlockCheck = now;
    return cachedAdBlockActive;
  } catch (e) {
    return false;
  }
}

function flagMode() {
  var flag = rd(ADBLOCK_FLAG_FILE);
  return !flag ? 'off' : flag === 'ads' ? 'ads' : 'full';
}

function adBlockMode() {
  return isTableMounted() ? flagMode() : 'off';
}

function isAdBlockActive() {
  return adBlockMode() !== 'off';
}

function tvUpdatesBlocked() {
  return fs.existsSync(HBC_BLOCK_UPDATES_FLAG);
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
  if (tvUpdatesBlocked()) {
    lines.push('', '# TV software updates, blocked by the flag the Homebrew Channel also uses');
    for (var u = 0; u < HBC_UPDATE_HOSTS.length; u++) sinkhole(lines, HBC_UPDATE_HOSTS[u]);
  }
  lines.push('');
  return lines.join('\n');
}

/*
 * One table carries both the ad block and the update block, so it stays
 * mounted while either is on. The Homebrew Channel mounts its own update block
 * at boot, under this one; with updates unblocked and nothing of ours to
 * mount, that layer is lifted too, or it would block until the next reboot.
 */
function applyHostsTable(cb) {
  var mode = flagMode();
  var mounted = isTableMounted();
  var done = function () { clearCache(); cb(null); };
  if (mode !== 'off' || tvUpdatesBlocked()) {
    try {
      fs.writeFileSync(ADBLOCK_HOSTS_FILE, adBlockHostsTable(mode), 'utf8');
    } catch (e) {
      return cb('could not write the hosts table: ' + e.message);
    }
    if (mounted) return done();
    return execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 },
      function (err) { clearCache(); cb(err ? 'could not mount the hosts table' : null); });
  }
  var liftHbc = function () {
    var hosts = rd('/etc/hosts') || '';
    if (hosts.indexOf('webosbrew startup script') === -1) return done();
    execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function () { done(); });
  };
  if (!mounted) return liftHbc();
  execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function () { clearCache(); liftHbc(); });
}

function setAdBlock(mode, cb) {
  try {
    if (mode === 'off') { if (fs.existsSync(ADBLOCK_FLAG_FILE)) fs.unlinkSync(ADBLOCK_FLAG_FILE); }
    else fs.writeFileSync(ADBLOCK_FLAG_FILE, mode, 'utf8');
  } catch (e) {
    if (cb) cb({ ok: false, error: msg('srv.adblock.saveFailed', 'could not save the ad block setting: {error}', { error: e.message }) });
    return;
  }
  applyHostsTable(function (err) {
    if (cb) cb({ ok: !err, error: err || undefined, enabled: isAdBlockActive(), mode: adBlockMode() });
  });
}

function setTvUpdatesBlocked(on, cb) {
  try {
    if (on) fs.writeFileSync(HBC_BLOCK_UPDATES_FLAG, '', 'utf8');
    else if (fs.existsSync(HBC_BLOCK_UPDATES_FLAG)) fs.unlinkSync(HBC_BLOCK_UPDATES_FLAG);
  } catch (e) {
    if (cb) cb({ ok: false, error: msg('srv.tvUpdates.saveFailed', 'could not save the update setting: {error}', { error: e.message }) });
    return;
  }
  applyHostsTable(function (err) {
    if (cb) cb({ ok: !err, error: err || undefined, tvUpdatesBlocked: tvUpdatesBlocked() });
  });
}

function checkBootAdBlock(cliMode) {
  if (cliMode) return;
  try {
    // Rebuilt from the list in this version, so an update that adds names
    // takes effect without the mode being switched off and on.
    var need = flagMode() !== 'off' || tvUpdatesBlocked();
    if (need) fs.writeFileSync(ADBLOCK_HOSTS_FILE, adBlockHostsTable(flagMode()), 'utf8');
    if (need && !isTableMounted()) {
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
  if (CONSENT_READ_BY[key]) { row.detail = CONSENT_READ_BY[key]; row.described = true; return row; }
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
      if (!CONSENT_LABELS[row.key] && !row.described) {
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
    var byDoc = CONSENT_LABELS[key] ? null : consentByDocument(key);
    if (CONSENT_LABELS[key]) {
      out.known.push({ key: key, label: CONSENT_LABELS[key][0], detail: CONSENT_LABELS[key][1],
                       enabled: on, settable: consentSettable(key),
                       group: consentGroup(key) });
    } else if (byDoc) {
      out.known.push({ key: key, label: byDoc[0], detail: byDoc[1], described: true,
                       enabled: on, settable: consentSettable(key), group: byDoc[2] });
    } else if (on || groups[key] || CONSENT_NAMES[key] || CONSENT_LOCKED[key]) {
      out.other.push(describeUnlabelled(key, on, groups));
    }
    // Otherwise left out: a flag that is off, that no agreement refers to and
    // that nothing on the TV reads (additional2 to 5 on the test TVs) says
    // nothing and can do nothing. It appears if it is ever on, or once a
    // firmware maps it to an agreement.
  }
  // The file's order is not stable: writing a flag moves it within the file,
  // so a list in that order reshuffles as flags are switched. Named flags go
  // in the order they are described above, the rest by key.
  var order = Object.keys(CONSENT_LABELS);
  function rank(f) { var i = order.indexOf(f.key); return i < 0 ? order.length : i; }
  out.known.sort(function (a, b) {
    return rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  out.other.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
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
          label: msg('srv.privacy.acr', 'Screen content recognition'),
          detail: msg('srv.privacy.acr.detail', 'LG’s ACR captures what is on screen, from apps and HDMI alike, to work out what you watch and target ads at you.'),
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
              label: msg('srv.privacy.adid', 'Advertising identifier'),
              detail: msg('srv.privacy.adid.detail', 'A unique ID your TV hands to advertisers so they can target ads at you. Resetting it breaks the link to your past activity.'),
              present: !!id,
              limitTracking: !!(ad && String(ad.LMT).toLowerCase() === 'on'),
              limitTrackingLabel: msg('srv.privacy.lmt', 'Limit ad tracking'),
              limitTrackingDetail: msg('srv.privacy.lmt.detail', 'When on, apps are asked not to use this ID to profile you.')
            };
            out.adblock = {
              enabled: isAdBlockActive(),
              mode: adBlockMode(),
              count: adBlockList('full').length,
              adCount: adBlockAds().length,
              platform: adBlockPlatform()
            };
            lgSettingsModule.collect(function (ls) {
              out.lgSettings = ls.rows;
              out.simple = simpleSummary(out);
              cachedPrivacy = out;
              lastPrivacyCheck = Date.now();
              cb(out);
            });
          });
        });
      });
    });
  });
}

/*
 * The short view both dashboards lead with: three things people mean by LG
 * tracking, what is still on under each, and how to switch each off. Voice and
 * LG Channels are left alone, since they run features people use, and so is
 * anything the TV will not let this server change.
 */
var SIMPLE_KEEP = { voiceAllowed: 1, voice2Allowed: 1 };

function simpleSummary(p) {
  var flags = ((p.consent && p.consent.known) || []).concat((p.consent && p.consent.other) || []);
  var writable = p.consentWritable !== false;
  var onIn = function (group) {
    /** @type {any[]} */
    var out = [];
    for (var i = 0; i < flags.length; i++) {
      var f = flags[i];
      if (f.group !== group || !f.enabled || !f.settable || !writable || SIMPLE_KEEP[f.key]) continue;
      out.push({ label: f.label || f.key, action: 'consent', value: { key: f.key, enabled: false } });
    }
    return out;
  };
  var ad = p.advertisingId || {};
  var mode = (p.adblock && p.adblock.mode) || 'off';

  var watching = onIn('watching');
  if (p.acr && p.acr.active && writable) {
    watching.push({ label: msg('srv.privacy.item.acr', 'Content recognition is running'), action: 'acr', value: false });
  }
  var ads = onIn('advertising');
  if (ad.available && !ad.limitTracking && writable) {
    ads.push({ label: msg('srv.privacy.item.lmt', 'Limit ad tracking is off'), action: 'limitAdTracking', value: true });
  }
  if (mode === 'off') {
    ads.push({ label: msg('srv.privacy.item.adblock', 'LG’s ad and tracking servers can be reached'), action: 'setAdBlock', value: 'ads' });
  }
  var reports = onIn('analytics');
  (p.daemons || []).forEach(function (x) {
    // Only what is running: one that is merely allowed to start is not on.
    if (!x.onDemand && x.stoppable && x.running) reports.push({ label: msg('srv.privacy.item.running', '{name} is running', { name: x.label }), service: x.name });
  });

  // LG's own ads and tips on screen, from lgsettings.js. Switching them off
  // stops nothing the TV does.
  var onScreen = [];
  (p.lgSettings || []).forEach(function (r) {
    if (r.section === 'promotions' && r.on && writable) onScreen.push({ label: r.title, action: 'lgSetting', value: { id: r.id, on: false } });
  });

  var areas = [
    { id: 'watching', name: msg('srv.privacy.area.watching', 'Screen recognition'), detail: msg('srv.privacy.area.watching.detail', 'LG identifying what you watch, to target ads at you.'), items: watching },
    { id: 'ads', name: msg('srv.privacy.area.ads', 'Ad tracking'), detail: msg('srv.privacy.area.ads.detail', 'Advertisers tracking the TV across apps, to target ads at you.'), items: ads },
    { id: 'reports', name: msg('srv.privacy.area.reports', 'Usage reports'), detail: msg('srv.privacy.area.reports.detail', 'Usage and diagnostic reports sent to LG, and data passed to other companies.'), items: reports },
    { id: 'onScreen', name: msg('srv.privacy.area.onScreen', 'LG ads on screen'), detail: msg('srv.privacy.area.onScreen.detail', 'Adverts, sponsored tiles and tips that LG shows on the TV.'), items: onScreen }
  ];
  var total = 0;
  areas.forEach(function (a) { total += a.items.length; });
  var kept = flags.filter(function (f) {
    return f.enabled && (SIMPLE_KEEP[f.key] || f.group === 'services');
  }).map(function (f) { return f.label || f.key; });
  return { total: total, areas: areas, kept: kept };
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

/*
 * Limit ad tracking is the TV's own setting, "lmt" in the general category,
 * which the ad service reports as LMT: on a C2 (webOS 9.2) writing one changed
 * the other within a second. Confirmed from the ad service, since that is the
 * value apps are given.
 */
function setLimitTracking(on, cb) {
  if (!luna) return cb({ ok: false, error: 'no luna wrapper' });
  luna('com.webos.settingsservice/setSystemSettings',
       { category: 'general', settings: { lmt: on ? 'on' : 'off' } }, function (r) {
    if (!r || r.returnValue !== true) return cb({ ok: false, error: msg('srv.tvRefused', 'the TV would not change it') });
    luna('com.webos.service.admanager/getAdid', {}, function (ad) {
      clearCache();
      var now = !!(ad && String(ad.LMT).toLowerCase() === 'on');
      cb(now === !!on ? { ok: true, limitTracking: now }
                      : { ok: false, error: msg('srv.notTaken', 'the setting did not take') });
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
    if (!cur || typeof cur !== 'object') return cb({ ok: false, error: msg('srv.consent.readFailed', 'could not read the consent flags') });
    if (!cur.hasOwnProperty(ckey)) return cb({ ok: false, error: 'no such consent flag: ' + ckey });

    readConsentDocs(function (eln) {
      if (!eln) return cb({ ok: false, error: msg('srv.consent.docsFailed', 'could not read the agreement documents') });
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
            : { ok: false, error: msg('srv.notApplied', 'the TV accepted the change without applying it') });
        });
      });
    });
  });
}

function init(opts) {
  opts = opts || {};
  if (opts.lgSettings) lgSettingsModule = opts.lgSettings;
  if (opts.luna) luna = opts.luna;
  if (opts.lunaCached) lunaCached = opts.lunaCached;
  if (opts.config) config = opts.config;
  if (luna) learnCountry();
}

// Saved so the boot-time table is right before the settings service answers.
function learnCountry() {
  luna('com.webos.settingsservice/getSystemSettings',
       { category: 'option', keys: ['smartServiceCountryCode2'] }, function (r) {
    var cc = String((r && r.settings && r.settings.smartServiceCountryCode2) || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc) || cc === (rd(COUNTRY_FILE) || '').toLowerCase()) return;
    try {
      fs.writeFileSync(COUNTRY_FILE, cc, 'utf8');
      if (isTableMounted()) fs.writeFileSync(ADBLOCK_HOSTS_FILE, adBlockHostsTable(flagMode()), 'utf8');
    } catch (e) {}
  });
}

module.exports = {
  init: init,
  isAdBlockActive: isAdBlockActive,
  adBlockMode: adBlockMode,
  adBlockPlatform: adBlockPlatform,
  adBlockList: adBlockList,
  setAdBlock: setAdBlock,
  tvUpdatesBlocked: tvUpdatesBlocked,
  setTvUpdatesBlocked: setTvUpdatesBlocked,
  checkBootAdBlock: checkBootAdBlock,
  resetAdId: resetAdId,
  setLimitTracking: setLimitTracking,
  clearAdCookies: clearAdCookies,
  collectPrivacy: collectPrivacy,
  simpleSummary: simpleSummary,
  setConsent: setConsent,
  readConsentFlags: readConsentFlags,
  clearCache: clearCache,
  ADBLOCK_ADS: ADBLOCK_ADS,
  ADBLOCK_PLATFORM: ADBLOCK_PLATFORM,
  adBlockHostsTable: adBlockHostsTable,
  CONSENT_LABELS: CONSENT_LABELS,
  CONSENT_LOCKED: CONSENT_LOCKED,
  CONSENT_GROUPS: CONSENT_GROUPS
};
