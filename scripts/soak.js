#!/usr/bin/env node
/*
 * Soak test against a real TV: how often the server stops answering, and how
 * it comes back from standby.
 *
 *   node scripts/soak.js --tv 192.168.1.134 --broker 192.168.1.125 --hours 8 --cycle 20
 *
 * Every 10s it asks the dashboard for its stats and times the answer. With a
 * broker, it also watches MQTT and records any gap in telemetry while the TV
 * is on. With --cycle N, every N minutes it switches the TV off, leaves it
 * long enough to fall asleep, wakes it with Wake-on-LAN and times how long the
 * dashboard and MQTT take to come back. With --ssh, it also reads the
 * watchdog's restart log at the end.
 *
 * With --restarts N (needs ssh as root), it instead restarts the server N
 * times, the moment the server has been seen to freeze, and times each start
 * until the dashboard answers. Any restart or stuck child the watchdog logs in
 * the meantime is reported.
 *
 * Options: --tv IP (required), --port 8080, --broker HOST[:PORT],
 * --prefix lgtv, --hours 1, --cycle 0 (minutes; 0 = never switch off),
 * --asleep 3 (minutes to leave the TV off), --mac (default: from the TV),
 * --ssh (read /var/lib/tvweb/tvweb.restarts as root at the end).
 */
'use strict';
const http = require('http');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
const MiniMQTT = require('../server/lib/mqtt');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
if (args.restarts) args.ssh = true;
if (!args.tv) { console.error('usage: soak.js --tv IP [--broker HOST] [--hours 1] [--cycle 0] [--ssh] [--restarts N]'); process.exit(2); }

const TV = args.tv, PORT = +args.port || 8080;
const HOURS = +args.hours || 1, CYCLE_MIN = +args.cycle || 0, ASLEEP_MIN = +args.asleep || 3;
const PREFIX = args.prefix || 'lgtv';
const started = Date.now(), endAt = started + HOURS * 3600e3;

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = m => console.log(stamp() + ' ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = {
  probes: 0, failed: 0, slow: 0, outages: [], mqttGaps: [], cycles: [], restarts: []
};

function request(method, path, body, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.request({ host: TV, port: PORT, path, method, timeout: timeoutMs,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ ok: res.statusCode === 200 && !!json, ms: Date.now() - t0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function wake(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  const pkt = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(hex, 'hex').copy(pkt, 6 + i * 6);
  const s = dgram.createSocket('udp4');
  s.bind(() => {
    s.setBroadcast(true);
    s.send(pkt, 9, '255.255.255.255', () => s.close());
  });
}

// ---- MQTT: status and telemetry freshness ----
let mqttStatus = null, lastTelemetry = 0, gapOpen = null;
if (args.broker) {
  const [host, port] = String(args.broker).split(':');
  const c = new MiniMQTT({ host, port: +port || 1883, clientId: 'soak-' + process.pid });
  c.on('error', () => {});
  c.on('connect', () => { c.subscribe(PREFIX + '/status'); c.subscribe(PREFIX + '/telemetry'); });
  c.on('message', (topic, payload) => {
    if (topic === PREFIX + '/status') mqttStatus = payload;
    if (topic === PREFIX + '/telemetry') lastTelemetry = Date.now();
  });
  c.connect();
}

// ---- probe loop: dashboard answering, and MQTT gaps while the TV is on ----
let cycling = false, outageOpen = null, tvOn = true;
async function probeLoop() {
  while (Date.now() < endAt) {
    if (!cycling) {
      const r = await request('GET', '/api/stats', null, 5000);
      results.probes++;
      if (r.ok) {
        tvOn = !!(r.json.powerState && r.json.powerState.systemOn);
        if (r.ms > 2000) { results.slow++; log('slow answer ' + r.ms + 'ms'); }
        if (outageOpen) {
          const secs = Math.round((Date.now() - outageOpen) / 1000);
          results.outages.push({ at: new Date(outageOpen).toISOString(), secs });
          log('dashboard back after ' + secs + 's');
          outageOpen = null;
        }
      } else {
        results.failed++;
        if (!outageOpen) { outageOpen = Date.now(); log('dashboard not answering (' + (r.error || 'bad reply') + ')'); }
      }
      if (args.broker && tvOn && !outageOpen) {
        const age = (Date.now() - lastTelemetry) / 1000;
        if (lastTelemetry && age > 40 && !gapOpen) { gapOpen = lastTelemetry; log('no MQTT telemetry for ' + Math.round(age) + 's'); }
        if (gapOpen && age < 15) {
          const secs = Math.round((Date.now() - gapOpen) / 1000);
          results.mqttGaps.push({ at: new Date(gapOpen).toISOString(), secs });
          log('MQTT telemetry back after ' + secs + 's');
          gapOpen = null;
        }
      }
    }
    await sleep(10000);
  }
}

// ---- power cycles: off, asleep, Wake-on-LAN, back ----
async function cycleLoop(mac) {
  while (Date.now() + (ASLEEP_MIN + 5) * 60e3 < endAt) {
    await sleep(CYCLE_MIN * 60e3);
    cycling = true;
    const cyc = { at: new Date().toISOString() };
    log('switching the TV off');
    const off = await request('POST', '/api/control', { action: 'powerOff' }, 10000);
    if (!off.ok || !off.json.ok) log('power off refused: ' + JSON.stringify(off.json || off.error));
    await sleep(ASLEEP_MIN * 60e3);
    const t0 = Date.now();
    log('waking with Wake-on-LAN');
    let back = null;
    while (Date.now() - t0 < 240e3) {
      wake(mac);
      const r = await request('GET', '/api/stats', null, 4000);
      if (r.ok && r.json.powerState && r.json.powerState.systemOn) { back = Date.now(); break; }
      await sleep(5000);
    }
    if (!back) {
      cyc.failed = 'dashboard did not come back within 4 minutes';
    } else {
      cyc.dashboardSecs = Math.round((back - t0) / 1000);
      if (args.broker) {
        while (Date.now() - back < 120e3 && !(mqttStatus === 'online' && lastTelemetry > back)) await sleep(1000);
        if (mqttStatus === 'online' && lastTelemetry > back) cyc.mqttSecs = Math.round((lastTelemetry - t0) / 1000);
        else cyc.failed = 'MQTT did not come back within 2 minutes of the dashboard (status ' + mqttStatus + ')';
      }
    }
    log('cycle: ' + JSON.stringify(cyc));
    results.cycles.push(cyc);
    lastTelemetry = Date.now();   // the TV was off; a gap then is expected
    cycling = false;
  }
}

// ---- restarts: the server's own start, repeated ----
async function restartLoop(count) {
  for (let i = 1; i <= count; i++) {
    const t0 = Date.now();
    try {
      execFileSync('ssh', ['-o', 'ConnectTimeout=8', 'root@' + TV, '/var/lib/tvweb/tvwebctl restart'], { stdio: 'ignore' });
    } catch (e) { log('restart ' + i + ': ssh failed'); }
    let up = null;
    while (Date.now() - t0 < 180e3) {
      const r = await request('GET', '/api/stats', null, 4000);
      if (r.ok) { up = Date.now(); break; }
      await sleep(1000);
    }
    const res = { n: i, answeredSecs: up ? Math.round((up - t0) / 1000) : null };
    // A start that froze late still answered once; watch it through the
    // window the watchdog judges a start by.
    if (up) {
      while (Date.now() - up < 60e3) {
        const r = await request('GET', '/api/stats', null, 4000);
        if (!r.ok) { res.stalled = true; break; }
        await sleep(5000);
      }
    }
    log('restart ' + JSON.stringify(res));
    results.cycles.push(res.answeredSecs && !res.stalled ? res : Object.assign(res, { failed: 'did not start cleanly' }));
  }
}

(async function main() {
  log('soak: ' + TV + ' for ' + HOURS + 'h' + (CYCLE_MIN ? ', power cycle every ' + CYCLE_MIN + ' min' : ''));
  let mac = args.mac;
  if (CYCLE_MIN && !mac) {
    const r = await request('GET', '/api/stats', null, 8000);
    mac = r.json && r.json.mac;
    if (!mac) { console.error('no MAC address from the TV; pass --mac'); process.exit(2); }
  }
  // By content, not count: the watchdog trims the file to its tail.
  const seen = args.ssh ? readRestarts() : [];
  const lastSeen = seen[seen.length - 1];
  if (args.restarts) await restartLoop(+args.restarts);
  else await Promise.all([probeLoop(), CYCLE_MIN ? cycleLoop(mac) : Promise.resolve()]);
  if (args.ssh) {
    const now = readRestarts();
    const at = lastSeen ? now.lastIndexOf(lastSeen) : -1;
    results.restarts = now.slice(at + 1);
  }
  const summary = {
    tv: TV, hours: HOURS, probes: results.probes, failedProbes: results.failed, slowProbes: results.slow,
    outages: results.outages, mqttGaps: results.mqttGaps,
    cycles: results.cycles.length, failedCycles: results.cycles.filter(c => c.failed),
    worstDashboardSecs: Math.max(0, ...results.cycles.map(c => c.dashboardSecs || c.answeredSecs || 0)),
    worstMqttSecs: Math.max(0, ...results.cycles.map(c => c.mqttSecs || 0)),
    restarts: results.restarts
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.outages.length || summary.failedCycles.length || summary.restarts.length ? 1 : 0);
})();

function readRestarts() {
  try {
    return execFileSync('ssh', ['-o', 'ConnectTimeout=8', 'root@' + TV, 'cat /var/lib/tvweb/tvweb.restarts'],
      { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e) { return []; }
}
