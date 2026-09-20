/*
 * Retained MQTT topics for the live state cache.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

function scalar(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function init(opts) {
  opts = opts || {};
  var client = opts.client;
  var prefix = opts.prefix || 'lgtv';
  var legacyScreenTopic = opts.legacyScreenTopic || (prefix + '/state/screen');
  var manager = null;

  function publishValue(group, key, value) {
    if (value === null || typeof value === 'undefined') return;
    client.publish(prefix + '/state/' + group + '/' + key, scalar(value), true);
    if (group === 'power' && key === 'screenOn') {
      var screenOn = !!value;
      if (manager) {
        var snap = manager.snapshot();
        var pwr = snap && snap.power;
        if (pwr && pwr.systemOn === false) screenOn = false;
      }
      client.publish(legacyScreenTopic, screenOn ? 'ON' : 'OFF', true);
    }
  }

  function onChange(event) {
    publishValue(event.group, event.key, event.value);
  }

  function attach(stateManager) {
    manager = stateManager;
    manager.onChange(onChange);
  }

  function publishSnapshot() {
    var values, group, key;
    if (!manager) return;
    values = manager.snapshot();
    for (group in values) {
      for (key in values[group]) publishValue(group, key, values[group][key]);
    }
  }

  return {
    attach: attach,
    publishSnapshot: publishSnapshot,
    publishValue: publishValue
  };
}

module.exports = {
  init: init
};
