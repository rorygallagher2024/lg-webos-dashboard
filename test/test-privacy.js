/**
 * test/test-privacy.js - Unit tests for the ad blocker's hosts table
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var privacy = require('../server/lib/privacy');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

var HBC_FLAG = '/var/luna/preferences/webosbrew_block_updates';
var UPDATE_HOSTS = ['snu.lge.com', 'su-dev.lge.com', 'su.lge.com', 'su-ssl.lge.com'];

function sinkholed(table, host) {
  return table.indexOf('0.0.0.0\t' + host) !== -1 && table.indexOf('::\t' + host) !== -1;
}

test('every blocked host is answered on both families', function () {
  ['ads', 'full'].forEach(function (mode) {
    var table = privacy.adBlockHostsTable(mode);
    var hosts = privacy.adBlockList(mode);
    hosts.forEach(function (host) {
      assert.ok(sinkholed(table, host), mode + ': ' + host + ' is missing an IPv4 or IPv6 line');
    });
  });
});

test('with the ad blocker off the table carries no ad hosts', function () {
  assert.deepEqual(privacy.adBlockList('off'), []);
  assert.ok(!sinkholed(privacy.adBlockHostsTable('off'), 'ad.lgsmartad.com'));
});

test('the summary counts what is on, and leaves voice, LG Channels and fixed flags alone', function () {
  var sm = privacy.simpleSummary({
    consentWritable: true,
    consent: { known: [
      { key: 'acrAllowed', group: 'watching', enabled: true, settable: true, label: 'Screen content recognition' },
      { key: 'voiceAllowed', group: 'watching', enabled: true, settable: true, label: 'Voice recordings' },
      { key: 'customAdAllowed', group: 'advertising', enabled: false, settable: true },
      { key: 'remoteDiagAllowed', group: 'analytics', enabled: true, settable: false },
      { key: 'chpAllowed', group: 'services', enabled: true, settable: true, label: 'LG Channels' }
    ], other: [] },
    acr: { active: true },
    advertisingId: { available: true, limitTracking: true },
    adblock: { mode: 'ads' },
    daemons: [{ name: 'uploadd', label: 'Diagnostics uploader', stoppable: true, running: false },
              { name: 'rdxd', label: 'Diagnostics collector', stoppable: true, running: true }]
  });
  var by = {};
  sm.areas.forEach(function (a) { by[a.id] = a.items; });
  assert.strictEqual(by.watching.length, 2);
  assert.strictEqual(by.ads.length, 0);
  assert.deepEqual(by.reports.map(function (i) { return i.service; }), ['rdxd']);
  assert.strictEqual(sm.total, 3);
  assert.deepEqual(sm.kept, ['Voice recordings', 'LG Channels']);
});

test("LG's ads on screen count, and switching all off turns off the ones that are on", function () {
  var sm = privacy.simpleSummary({
    consentWritable: true,
    consent: { known: [], other: [] },
    adblock: { mode: 'ads' },
    lgSettings: [
      { id: 'livePromotion', section: 'promotions', title: 'Ads while watching', on: true },
      { id: 'homePromotion', section: 'promotions', title: 'Sponsored tiles on Home', on: false }
    ]
  });
  var screen = sm.areas.filter(function (a) { return a.id === 'onScreen'; })[0];
  assert.deepEqual(screen.items, [{ label: 'Ads while watching', action: 'lgSetting', value: { id: 'livePromotion', on: false } }]);
  assert.strictEqual(sm.total, 1);
});

test('the table still carries the marker the mount is detected by', function () {
  assert.ok(privacy.adBlockHostsTable('ads').indexOf('lg-webos-dashboard') !== -1);
});

test('localhost keeps its own entries', function () {
  var table = privacy.adBlockHostsTable('ads');
  assert.ok(table.indexOf('127.0.0.1\tlocalhost.localdomain\tlocalhost') !== -1);
  assert.ok(table.indexOf('::1\tlocalhost ip6-localhost ip6-loopback') !== -1);
});

test("LG's update servers are left out when the Homebrew flag is not set", function () {
  var table = privacy.adBlockHostsTable('full');
  UPDATE_HOSTS.forEach(function (host) {
    assert.ok(table.indexOf(host) === -1, host + ' should not be blocked unasked');
  });
});

test("they are carried over when it is, so this table does not undo it", function () {
  mockEnv.files[HBC_FLAG] = '';
  try {
    var table = privacy.adBlockHostsTable('ads');
    UPDATE_HOSTS.forEach(function (host) {
      assert.ok(sinkholed(table, host), host + ' should be blocked while the flag is set');
    });
  } finally {
    delete mockEnv.files[HBC_FLAG];
  }
});

var failures = 0;
tests.forEach(function (t) {
  try {
    t[1]();
    console.log('  ✓ ' + t[0]);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + t[0] + '\n      ' + e.message);
  }
});
mockEnv.restore();
process.exit(failures ? 1 : 0);
