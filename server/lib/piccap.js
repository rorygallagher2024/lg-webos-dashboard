/* PicCap's Luna and MQTT controls. Strict ES5. */
var fs = require('fs');
var msg = require('./say').msg;
var SERVICE = 'org.webosbrew.piccap.service/';
var APP_DIR = '/media/developer/apps/usr/palm/applications/org.webosbrew.piccap';
var STATUS_CACHE_MS = 4000;
var lunaFn = null;
var available = false;
var isRunning = null;
var checkedAt = 0;
var inFlight = false;
var waiters = [];
var forceWaiters = [];
var mqttClient = null;
var stateTopic = '';
var lastPublishedState = null;
var allowControl = false;
var pollTimer = null;
var pollIntervalMs = 30000;
/** @type {function(boolean): void} */
var onAvailableChange = function () {};

function current() {
  return { available: available, isRunning: isRunning };
}

function missingService(response, raw) {
  var text = String(response && (response.errorText || response.error) || raw || '').toLowerCase();
  return /unknown method|no such service|service.{0,24}(not found|does not exist|not registered)|method.{0,24}(not found|does not exist)/.test(text);
}

function flush(callbacks, value) {
  for (var i = 0; i < callbacks.length; i++) {
    try { callbacks[i](value); } catch (e) {}
  }
}

function requestStatus() {
  checkedAt = Date.now();
  lunaFn(SERVICE + 'status', {}, function (response, raw) {
    var was = available;
    if (response && response.returnValue !== false && typeof response.isRunning === 'boolean') {
      available = true;
      isRunning = response.isRunning;
    } else if (missingService(response, raw)) {
      available = false;
      isRunning = null;
    }
    // Home Assistant's switch exists only while PicCap answers.
    if (available !== was) onAvailableChange(available);

    var callbacks = waiters;
    waiters = [];
    var refresh = forceWaiters.length > 0;
    if (refresh) {
      waiters = forceWaiters;
      forceWaiters = [];
    } else {
      inFlight = false;
    }
    flush(callbacks, current());
    if (refresh) requestStatus();
  });
}

function getStatus(cb, force) {
  cb = cb || function () {};
  var now = Date.now();
  if (inFlight) {
    (force ? forceWaiters : waiters).push(cb);
    return;
  }
  if (!force && checkedAt && now >= checkedAt && now - checkedAt < STATUS_CACHE_MS) return cb(current());

  inFlight = true;
  waiters.push(cb);
  requestStatus();
}

function setPower(on, cb) {
  if (typeof on !== 'boolean') return cb({ ok: false, error: 'power must be true or false' });
  getStatus(function (state) {
    if (!state.available) {
      return cb({ ok: false, available: false, error: msg('srv.piccap.unavailable', 'PicCap is not available') });
    }
    lunaFn(SERVICE + (on ? 'start' : 'stop'), {}, function (response) {
      var ok = !!(response && response.returnValue === true);
      var error = response && (response.errorText || response.errorCode);
      setTimeout(function () {
        getStatus(function (latest) {
          cb({
            ok: ok,
            available: latest.available,
            isRunning: latest.isRunning,
            error: ok ? undefined : (error || msg('srv.piccap.refused', 'PicCap refused the request'))
          });
        }, true);
      }, 400);
    });
  });
}

function publishState(state, force) {
  if (!mqttClient || !mqttClient.connected) return;
  if (!state || typeof state.available !== 'boolean') state = current();
  var payload = state.available ? (state.isRunning ? 'ON' : 'OFF') : '';
  if (!force && payload === lastPublishedState) return;
  mqttClient.publish(stateTopic, payload, true);
  lastPublishedState = payload;
}

function refreshAndPublishState(forcePublish) {
  getStatus(function (state) {
    publishState(state, forcePublish === true);
  }, true);
}

function getState() {
  return available && typeof isRunning === 'boolean' ? { isRunning: isRunning } : null;
}

function attachMqtt(opts) {
  opts = opts || {};
  mqttClient = opts.client || null;
  stateTopic = (opts.prefix || 'lgtv') + '/state/piccap/power';
  allowControl = opts.allowControl === true;
  if (pollTimer) clearInterval(pollTimer);
  // Poll independently of telemetry, and only while MQTT can receive the state.
  pollTimer = setInterval(function () {
    if (mqttClient && mqttClient.connected) refreshAndPublishState();
  }, pollIntervalMs);
}

function handleMqttCommand(action, value, cb) {
  if (action !== 'piccap/power') return false;
  var power = String(value === undefined || value === null ? '' : value).toUpperCase();
  if (power !== 'ON' && power !== 'OFF') {
    console.log('mqtt: invalid PicCap power command: expected ON or OFF, got ' + power);
    return true;
  }
  if (!allowControl) {
    var disabled = { ok: false, error: msg('srv.controlsOff', 'controls disabled in config') };
    console.log('mqtt: PicCap command failed: ' + JSON.stringify(disabled));
    if (cb) cb(disabled);
    return true;
  }
  setPower(power === 'ON', function (result) {
    publishState(result);
    if (!result || !result.ok) console.log('mqtt: PicCap command failed: ' + JSON.stringify(result));
    if (cb) cb(result);
  });
  return true;
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  if (typeof opts.onAvailableChange === 'function') onAvailableChange = opts.onAvailableChange;
  var interval = parseInt(opts.pollIntervalMs, 10);
  pollIntervalMs = interval >= 1000 && interval <= 600000 ? interval : 30000;
  return {
    attachMqtt: attachMqtt,
    refreshAndPublishState: refreshAndPublishState,
    getState: getState,
    handleMqttCommand: handleMqttCommand
  };
}

function initNoop() {
  return {
    attachMqtt: function () {},
    refreshAndPublishState: function () {},
    getState: function () { return null; },
    handleMqttCommand: function () { return false; }
  };
}

/* Whether the app is on the TV: a look at its folder, without asking its service. */
function installed() {
  try { return fs.existsSync(APP_DIR); } catch (e) { return false; }
}

module.exports = { init: init, initNoop: initNoop, installed: installed, APP_DIR: APP_DIR };
