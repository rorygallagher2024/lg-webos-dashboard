/*
 * Home Assistant discovery entities, catalogue, category grouping,
 * and discovery filtering for Node 0.12+ (strict ES5).
 */

var INPUTS = { hdmi1: 1, hdmi2: 1, hdmi3: 1, hdmi4: 1, livetv: 1 };
var INPUT_NAMES = { hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', livetv: 'Live TV' };

// Screen saver names come from the registry, so a new one reaches Home
// Assistant without a second list to keep in step (Bokeh was missed once).
var SS = require('./screensavers').SCREENSAVERS;
var SS_IDS = Object.keys(SS);
function ssMap(byLabel) {
  var m = {};
  SS_IDS.forEach(function (k) { if (byLabel) m[SS[k].label] = k; else m[k] = SS[k].label; });
  return m;
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
  personalized: 'Personalized',
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

var SOUND_OUTPUT_MAP = {
  tv_speaker: 'TV Speaker',
  external_arc: 'HDMI ARC',
  optical: 'Optical',
  external_optical: 'Optical',
  headphone: 'Headphone / AUX',
  bt_soundbar: 'Bluetooth',
  external_speaker: 'External Speaker',
  lineout: 'Line Out',
  soundbar: 'LG Sound Sync',
  tv_speaker_headphone: 'TV Speaker + Headphone',
  internal: 'TV Speaker'
};

var HA_CATEGORIES = [
  { id: 'controls', name: 'Controls & Media', desc: 'Power, volume, mute, playback buttons, apps, and input sources.' },
  { id: 'oled', name: 'OLED Care', desc: 'Panel on-time, pixel refresher countdowns, and burn-in protections.' },
  { id: 'video', name: 'Video & HDMI Signal', desc: 'Active picture mode, dynamic range, refresh rate, VRR, ALLM, and link mode.' },
  { id: 'system', name: 'System & Telemetry', desc: 'CPU, RAM, swap, SoC temperature, network rates, and storage health.' },
  { id: 'diagnostics', name: 'Diagnostics & Settings', desc: 'Remote battery, audio format, standby LED, sleep timer, and ad blocker.' }
];

var HA_ENTITIES = [
  // Controls & Media
  { id: 'display_panel', type: 'switch', name: 'Display Panel', cat: 'controls' },
  { id: 'mute', type: 'switch', name: 'Mute', cat: 'controls' },
  { id: 'volume', type: 'number', name: 'Volume', cat: 'controls' },
  { id: 'input_source', type: 'select', name: 'Input Source', cat: 'controls' },
  { id: 'screen_notification', type: 'text', name: 'Screen Notification', cat: 'controls' },
  { id: 'picture_mode', type: 'select', name: 'Picture Mode (Select)', cat: 'controls' },
  { id: 'energy_saving', type: 'select', name: 'Energy Saving Step', cat: 'controls' },
  { id: 'sound_output', type: 'select', name: 'Sound Output', cat: 'controls' },
  { id: 'app', type: 'select', name: 'Application', cat: 'controls' },
  { id: 'active_app', type: 'sensor', name: 'Active App', cat: 'controls' },
  { id: 'play_state', type: 'sensor', name: 'Player State', cat: 'controls' },
  { id: 'play', type: 'button', name: 'Play', cat: 'controls' },
  { id: 'pause', type: 'button', name: 'Pause', cat: 'controls' },
  { id: 'play_pause', type: 'button', name: 'Play / Pause', cat: 'controls' },
  { id: 'stop', type: 'button', name: 'Stop', cat: 'controls' },
  { id: 'screensaver', type: 'button', name: 'Screen Saver', cat: 'controls' },
  { id: 'screen_saver_active', type: 'binary_sensor', name: 'Screen Saver Active', cat: 'controls' },
  { id: 'screensaver_mode', type: 'select', name: 'Screen Saver Mode', cat: 'controls' },
  { id: 'restart', type: 'button', name: 'Restart', cat: 'controls' },
  { id: 'power_off', type: 'button', name: 'Power Off', cat: 'controls' },

  // OLED Care
  { id: 'oled_panel_hours', type: 'sensor', name: 'OLED Panel Hours', cat: 'oled' },
  { id: 'oled_hours_since_compensation', type: 'sensor', name: 'Hours Since Compensation', cat: 'oled' },
  { id: 'oled_hours_until_compensation', type: 'sensor', name: 'Hours Until Compensation', cat: 'oled' },
  { id: 'oled_hours_since_refresher', type: 'sensor', name: 'Hours Since Pixel Refresher', cat: 'oled' },
  { id: 'oled_hours_until_refresher', type: 'sensor', name: 'Hours Until Pixel Refresher', cat: 'oled' },
  { id: 'oled_compensation_status', type: 'sensor', name: 'Compensation Status', cat: 'oled' },
  { id: 'oled_refresher_status', type: 'sensor', name: 'Pixel Refresher Status', cat: 'oled' },
  { id: 'oled_screen_shift', type: 'switch', name: 'Screen Shift', cat: 'oled' },
  { id: 'oled_logo_dimming', type: 'select', name: 'Logo Luminance Adjustment', cat: 'oled' },
  { id: 'oled_short_cycles', type: 'sensor', name: 'Compensation Cycles Completed', cat: 'oled' },
  { id: 'oled_refresher_cycles', type: 'sensor', name: 'Pixel Refresher Cycles Completed', cat: 'oled' },
  { id: 'oled_failure_alerts', type: 'sensor', name: 'Panel Maintenance Alerts', cat: 'oled' },
  { id: 'oled_asbl_dimmer', type: 'binary_sensor', name: 'ASBL Dimming Active', cat: 'oled' },
  { id: 'pixel_refresher_schedule', type: 'switch', name: 'Pixel Refresher on Next Standby', cat: 'oled' },
  { id: 'oled_cell_type', type: 'sensor', name: 'OLED Cell Type', cat: 'oled' },
  { id: 'tcon_firmware', type: 'sensor', name: 'T-Con Firmware', cat: 'oled' },

  // Video & HDMI Signal
  { id: 'dynamic_range', type: 'sensor', name: 'Dynamic Range', cat: 'video' },
  { id: 'picture_mode', type: 'sensor', name: 'Picture Mode', cat: 'video' },
  { id: 'oled_light', type: 'sensor', name: 'OLED Light', cat: 'video' },
  { id: 'video_signal', type: 'sensor', name: 'Video Signal', cat: 'video' },
  { id: 'hdmi_link_mode', type: 'sensor', name: 'HDMI Link Mode', cat: 'video' },
  { id: 'hdmi_chroma', type: 'sensor', name: 'HDMI Chroma', cat: 'video' },
  { id: 'hdmi_hdcp', type: 'sensor', name: 'HDMI HDCP Version', cat: 'video' },
  { id: 'hdmi_cable_errors', type: 'sensor', name: 'HDMI Cable Physical Errors', cat: 'video' },
  { id: 'hdmi_allm', type: 'binary_sensor', name: 'HDMI ALLM', cat: 'video' },
  { id: 'hdmi_vrr', type: 'binary_sensor', name: 'HDMI VRR', cat: 'video' },
  { id: 'video_colorimetry', type: 'sensor', name: 'Colorimetry', cat: 'video' },
  { id: 'panel_dimming', type: 'sensor', name: 'Panel Dimming', cat: 'video' },
  { id: 'ambient_light', type: 'sensor', name: 'Ambient Light', cat: 'video' },

  // System & Telemetry
  { id: 'soc_temperature', type: 'sensor', name: 'SoC Temperature', cat: 'system' },
  { id: 'cpu_load', type: 'sensor', name: 'CPU Usage', cat: 'system' },
  { id: 'memory_usage', type: 'sensor', name: 'Memory Usage', cat: 'system' },
  { id: 'swap_usage', type: 'sensor', name: 'Swap Usage', cat: 'system' },
  { id: 'wifi_signal', type: 'sensor', name: 'Wi-Fi Signal', cat: 'system' },
  { id: 'download_rate', type: 'sensor', name: 'Download Rate', cat: 'system' },
  { id: 'upload_rate', type: 'sensor', name: 'Upload Rate', cat: 'system' },
  { id: 'flash_health', type: 'sensor', name: 'Flash Storage Health', cat: 'system' },
  { id: 'flash_wear', type: 'sensor', name: 'Flash Wear Level', cat: 'system' },
  { id: 'soc_current', type: 'sensor', name: 'SoC Current', cat: 'system' },
  { id: 'soc_architecture', type: 'sensor', name: 'SoC Architecture', cat: 'system' },
  { id: 'gpu_clock', type: 'sensor', name: 'GPU Clock', cat: 'system' },
  { id: 'app_storage_free', type: 'sensor', name: 'App Storage Available', cat: 'system' },
  { id: 'mac_address', type: 'sensor', name: 'MAC Address', cat: 'system' },
  { id: 'uptime', type: 'sensor', name: 'Uptime', cat: 'system' },

  // Diagnostics & Settings
  { id: 'audio_output', type: 'sensor', name: 'Audio Output', cat: 'diagnostics' },
  { id: 'remote_battery', type: 'sensor', name: 'Magic Remote Battery', cat: 'diagnostics' },
  { id: 'sleep_timer', type: 'select', name: 'Sleep Timer', cat: 'diagnostics' },
  { id: 'standby_light', type: 'switch', name: 'Standby Light', cat: 'diagnostics' },
  { id: 'logo_light', type: 'switch', name: 'Logo Light', cat: 'diagnostics' },
  { id: 'ad_blocker', type: 'switch', name: 'Ad Blocker', cat: 'diagnostics' },
  { id: 'tvweb_version', type: 'sensor', name: 'tvweb Version', cat: 'diagnostics' },
  { id: 'server_update', type: 'update', name: 'Server Update', cat: 'diagnostics' }
];

var ENTITY_CATEGORIES = {};
for (var i = 0; i < HA_ENTITIES.length; i++) {
  var _ent = HA_ENTITIES[i];
  ENTITY_CATEGORIES[_ent.type + '.' + _ent.id] = _ent.cat;
  if (!ENTITY_CATEGORIES[_ent.id]) {
    ENTITY_CATEGORIES[_ent.id] = _ent.cat;
  }
}

function entityCategory(e) {
  if (!e) return 'diagnostics';
  return ENTITY_CATEGORIES[e.type + '.' + e.id] || ENTITY_CATEGORIES[e.id] || 'diagnostics';
}

/*
 * Launch App options by name. Before the app list has loaded, the common apps
 * stand in so the select is not empty. A name two apps share gets the id of
 * the second, since the select needs every option to be distinct.
 */
var DEFAULT_APPS = {
  'com.webos.app.livetv': 'Live TV',
  'youtube.leanback.v4': 'YouTube',
  'netflix': 'Netflix',
  'amazon': 'Prime Video',
  'spotify-beehive': 'Spotify',
  'com.apple.appletv': 'Apple TV'
};

function appNames(installed) {
  var byId = {}, taken = {};
  var add = function (id, title) {
    if (byId[id]) return;
    var name = title || id;
    if (taken[name]) name += ' (' + id + ')';
    taken[name] = true;
    byId[id] = name;
  };
  if (!installed || !installed.length) {
    for (var d in DEFAULT_APPS) add(d, DEFAULT_APPS[d]);
  } else {
    for (var i = 0; i < installed.length; i++) add(installed[i].id, installed[i].title);
  }
  return byId;
}

/*
 * A select that shows names but sends and reads ids. Where two ids share a
 * name (optical and external_optical are both "Optical"), the first id is the
 * one sent. A value sent that is not a listed name goes through as written,
 * so an automation still sending the id keeps working.
 */
function namedSelect(ids, names, stateExpr) {
  var toId = {}, toName = {}, options = [];
  for (var i = 0; i < ids.length; i++) {
    var name = names[ids[i]] || ids[i];
    toName[ids[i]] = name;
    if (!toId[name]) { toId[name] = ids[i]; options.push(name); }
  }
  return {
    options: options,
    command_template: '{{ ' + JSON.stringify(toId) + '.get(value, value) }}',
    value_template: '{{ ' + JSON.stringify(toName) + '.get(' + stateExpr + ', "None") }}'
  };
}

function withSelect(payload, sel) {
  for (var k in sel) payload[k] = sel[k];
  return payload;
}

function selectState(expr, options) {
  var quoted = [];
  for (var i = 0; i < options.length; i++) quoted.push('\'' + options[i] + '\'');
  return '{{ (' + expr + ') if (' + expr + ') in [' + quoted.join(', ') + '] else \'None\' }}';
}

/*
 * What the dashboard reports about the bridge. The MQTT client is wired up
 * once at startup against the config as it was then, so this is the only way
 * to tell whether the broker settings on screen are the ones actually running.
 */

var RETIRED_ENTITIES = [
    { type: 'sensor', id: 'oled_screen_shift' },
    { type: 'sensor', id: 'oled_logo_dimming' }
  ];

var HDMI_DIAG_ONLY = {
      hdmi_link_mode: 'phy_mode', hdmi_chroma: 'chroma', hdmi_hdcp: 'hdcp',
      hdmi_cable_errors: 'phy_errors', hdmi_allm: 'allm', hdmi_vrr: 'vrr'
    };

    var OLED_ONLY = {
      oled_panel_hours: 1, oled_hours_since_compensation: 1,
      oled_hours_until_compensation: 1, oled_compensation_status: 1,
      oled_hours_since_refresher: 1,
      oled_hours_until_refresher: 1, oled_refresher_status: 1,
      oled_short_cycles: 1, oled_refresher_cycles: 1,
      oled_failure_alerts: 1, oled_asbl_dimmer: 1,
      oled_cell_type: 1, tcon_firmware: 1,
      oled_screen_shift: 1, oled_logo_dimming: 1,
      pixel_refresher_schedule: 1
    };

function clearRetired(publishFn, discPfx, devId) {
  for (var r = 0; r < RETIRED_ENTITIES.length; r++) {
    publishFn(discPfx + '/' + RETIRED_ENTITIES[r].type + '/' + devId + '/' +
              RETIRED_ENTITIES[r].id + '/config', '', true);
  }
}

function buildEntities(opts) {
  opts = opts || {};
  var pfx = opts.pfx || 'lgtv';
  var telemetryTopic = opts.telemetryTopic || (pfx + '/telemetry');
  var statusTopic = opts.statusTopic || (pfx + '/status');
  var stateScreenTopic = opts.stateScreenTopic || (pfx + '/state/screen');
  var cmdScreenTopic = opts.cmdScreenTopic || (pfx + '/command/screen');
  var cmdMuteTopic = opts.cmdMuteTopic || (pfx + '/command/mute');
  var cmdVolTopic = opts.cmdVolTopic || (pfx + '/command/volume');
  var cmdInputTopic = opts.cmdInputTopic || (pfx + '/command/input');
  var cmdToastTopic = opts.cmdToastTopic || (pfx + '/command/toast');
  var energySavingTopic = opts.energySavingTopic || (pfx + '/state/picture/energySaving');
  var updateTopic = opts.updateTopic || (pfx + '/update');
  var installedApps = opts.installedApps || [];
  var lastPicModes = opts.pictureModes || [];

  /** @type {any[]} */
  var entities = [
      {
        type: 'sensor', id: 'soc_temperature',
        payload: {
          name: 'SoC Temperature',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.temp }}',
          unit_of_measurement: '°C',
          device_class: 'temperature',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'cpu_load',
        payload: {
          name: 'CPU Usage',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.load }}',
          unit_of_measurement: '%',
          state_class: 'measurement',
          icon: 'mdi:cpu-64-bit'
        }
      },
      {
        type: 'sensor', id: 'memory_usage',
        payload: {
          name: 'Memory Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.mem.total - value_json.mem.avail) / value_json.mem.total * 100) | round(1) if value_json.mem.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:memory'
        }
      },
      {
        type: 'sensor', id: 'swap_usage',
        payload: {
          name: 'Swap Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.swap.total - value_json.swap.free) / value_json.swap.total * 100) | round(1) if value_json.swap.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:server'
        }
      },
      {
        type: 'sensor', id: 'wifi_signal',
        payload: {
          name: 'Wi-Fi Signal',
          state_topic: telemetryTopic,
          // none, not 0: a wired set has no signal to report, and 0 dBm would
          // enter the history as though it had been measured.
          value_template: '{{ value_json.wifi.level if value_json.wifi else none }}',
          unit_of_measurement: 'dBm',
          device_class: 'signal_strength',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'download_rate',
        payload: {
          name: 'Download Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.rx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:download-network'
        }
      },
      {
        type: 'sensor', id: 'upload_rate',
        payload: {
          name: 'Upload Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.tx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:upload-network'
        }
      },
      {
        type: 'sensor', id: 'flash_health',
        payload: {
          name: 'Flash Storage Health',
          state_topic: telemetryTopic,
          /* pre_eol_info, not the inverted wear band: emmc.health is derived
             from the same register as emmc.wear, so the two sensors were
             reporting one number twice. The name still fits - Normal, Warning
             and Urgent are exactly a health status. */
          value_template: '{{ value_json.emmc.eol }}',
          icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'flash_wear',
        payload: {
          name: 'Flash Wear Level',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.emmc.wear }}',
          icon: 'mdi:wrench-clock'
        }
      },
      {
        type: 'sensor', id: 'active_app',
        payload: {
          name: 'Active App',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.display_title or value_json.app_name or value_json.app }}',
          icon: 'mdi:television-play'
        }
      },
      {
        type: 'sensor', id: 'play_state',
        payload: {
          name: 'Player State',
          state_topic: telemetryTopic,
          // Absent on a set whose media service does not answer, rather than
          // reported as stopped - nothing playing and nothing to ask are
          // different things. On an external input this tracks the HDMI
          // pipeline rather than the source's own transport state.
          value_template: '{{ value_json.media.state if value_json.media else None }}',
          icon: 'mdi:play-pause'
        }
      },
      {
        type: 'sensor', id: 'dynamic_range',
        payload: {
          name: 'Dynamic Range',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.dynamicRange if value_json.picture else "SDR" }}',
          icon: 'mdi:video-vintage'
        }
      },
      {
        type: 'sensor', id: 'picture_mode',
        payload: {
          name: 'Picture Mode',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.mode if value_json.picture else "Unknown" }}',
          icon: 'mdi:palette'
        }
      },
      {
        type: 'sensor', id: 'oled_light',
        payload: {
          name: 'OLED Light',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.backlight if value_json.picture else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:brightness-6'
        }
      },
      {
        type: 'sensor', id: 'video_signal',
        payload: {
          name: 'Video Signal',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.signal or "Internal / Standby" }}',
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'sensor', id: 'hdmi_link_mode',
        payload: {
          name: 'HDMI Link Protocol',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.phy_mode if value_json.hdmi_diag and value_json.hdmi_diag.phy_mode else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'sensor', id: 'hdmi_chroma',
        payload: {
          name: 'HDMI Chroma Format',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.chroma if value_json.hdmi_diag and value_json.hdmi_diag.chroma else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:palette'
        }
      },
      {
        type: 'sensor', id: 'hdmi_hdcp',
        payload: {
          name: 'HDMI HDCP Version',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.hdcp if value_json.hdmi_diag and value_json.hdmi_diag.hdcp else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:lock-check'
        }
      },
      {
        type: 'sensor', id: 'hdmi_cable_errors',
        payload: {
          name: 'HDMI Cable Bit Errors',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hdmi_diag.phy_errors if value_json.hdmi_diag and value_json.hdmi_diag.phy_errors is not none else none }}',
          state_class: 'measurement',
          entity_category: 'diagnostic',
          icon: 'mdi:alert-outline'
        }
      },
      {
        type: 'binary_sensor', id: 'hdmi_allm',
        payload: {
          name: 'Auto Low Latency Mode (ALLM)',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.hdmi_diag.allm else "OFF") if value_json.hdmi_diag and value_json.hdmi_diag.allm is not none else none }}',
          icon: 'mdi:gamepad-variant'
        }
      },
      {
        type: 'binary_sensor', id: 'hdmi_vrr',
        payload: {
          name: 'Variable Refresh Rate (VRR)',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.hdmi_diag.vrr else "OFF") if value_json.hdmi_diag and value_json.hdmi_diag.vrr is not none else none }}',
          icon: 'mdi:speedometer'
        }
      },
      {
        type: 'sensor', id: 'video_colorimetry',
        payload: {
          name: 'Video Color Space',
          state_topic: telemetryTopic,
          // none, not "BT.709": defaulting to a colour space states a fact
          // about the signal that was never read, and states it wrongly on
          // anything wide-gamut. A set that does not report one reports none.
          value_template: '{{ value_json.picture_engine.colorimetry if value_json.picture_engine and value_json.picture_engine.colorimetry else none }}',
          icon: 'mdi:palette-swatch'
        }
      },
      {
        type: 'sensor', id: 'audio_output',
        payload: {
          name: 'Audio Output',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.audio_output or "Internal" }}',
          icon: 'mdi:speaker'
        }
      },
      {
        type: 'sensor', id: 'soc_current',
        payload: {
          name: 'SoC Current',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.power.current_ma if value_json.power else 0 }}',
          unit_of_measurement: 'mA',
          device_class: 'current',
          state_class: 'measurement',
          icon: 'mdi:current-ac'
        }
      },
      {
        type: 'sensor', id: 'uptime',
        payload: {
          name: 'Uptime',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.bootTime }}',
          device_class: 'timestamp',
          entity_category: 'diagnostic',
          icon: 'mdi:clock-start'
        }
      },
      {
        /*
         * This server's own version, not the TV's - the device's sw_version
         * already carries the firmware. The id stays tvweb_version: it is the
         * unique_id an existing install is already discovered under, and
         * changing it would orphan that entity and register a second one.
         * Diagnostic: it belongs beside the firmware, not among the readings.
         */
        type: 'sensor', id: 'tvweb_version',
        payload: {
          name: 'Server Version',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.tvwebVersion }}',
          entity_category: 'diagnostic',
          icon: 'mdi:tag-outline'
        }
      },
      {
        /*
         * For the wake_on_lan.send_magic_packet action the Home Assistant
         * guide sets up, where the address is currently left to the reader.
         * Diagnostic: it belongs on the device page beside the firmware, and
         * it is read once rather than watched.
         */
        type: 'sensor', id: 'mac_address',
        payload: {
          name: 'MAC Address',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.mac if value_json.mac else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:ethernet'
        }
      },
      {
        type: 'sensor', id: 'remote_battery',
        payload: {
          name: 'Remote Battery',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.remote.battery if value_json.remote and value_json.remote.battery is not none else none }}',
          unit_of_measurement: '%',
          device_class: 'battery',
          state_class: 'measurement',
          entity_category: 'diagnostic',
          icon: 'mdi:remote'
        }
      },
      {
        type: 'sensor', id: 'soc_architecture',
        payload: {
          name: 'SoC Architecture',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.hardware.soc_arch if value_json.hardware and value_json.hardware.soc_arch else "Unknown" }}',
          entity_category: 'diagnostic',
          icon: 'mdi:cpu-64-bit'
        }
      },
      {
        type: 'sensor', id: 'oled_cell_type',
        payload: {
          name: 'OLED Cell Info',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.panel_silicon.cell if value_json.panel_silicon and value_json.panel_silicon.cell else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:monitor-cell'
        }
      },
      {
        type: 'sensor', id: 'tcon_firmware',
        payload: {
          name: 'TCON Firmware',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.panel_silicon.tcon_firmware if value_json.panel_silicon and value_json.panel_silicon.tcon_firmware else none }}',
          entity_category: 'diagnostic',
          icon: 'mdi:chip'
        }
      },
      {
        type: 'switch', id: 'display_panel',
        payload: {
          name: (opts.isOled === false) ? 'Display Panel' : 'OLED Display Panel',
          command_topic: cmdScreenTopic,
          state_topic: stateScreenTopic,
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'switch', id: 'mute',
        payload: {
          name: 'Mute',
          command_topic: cmdMuteTopic,
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.muted else \'OFF\' }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:volume-mute'
        }
      },
      {
        type: 'number', id: 'volume',
        payload: {
          name: 'Volume',
          command_topic: cmdVolTopic,
          state_topic: telemetryTopic,
          value_template: '{{ value_json.volume }}',
          min: 0,
          max: 100,
          step: 1,
          icon: 'mdi:volume-high'
        }
      },
      {
        type: 'select', id: 'input_source',
        payload: withSelect({
          name: 'Input Source',
          command_topic: cmdInputTopic,
          state_topic: telemetryTopic,
          icon: 'mdi:video-input-hdmi'
        }, namedSelect(Object.keys(INPUTS), INPUT_NAMES, 'value_json.app'))
      },
      {
        type: 'text', id: 'screen_notification',
        payload: {
          name: 'Screen Notification',
          command_topic: cmdToastTopic,
          icon: 'mdi:message-text-outline',
          mode: 'text'
        }
      },
      {
        type: 'sensor', id: 'oled_panel_hours',
        payload: {
          name: 'OLED Panel Hours',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.panel_hours if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'total_increasing',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_compensation',
        payload: {
          name: 'OLED Hours Since Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:progress-clock'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_compensation',
        payload: {
          name: 'OLED Hours Until Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:timer-sand'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_refresher',
        payload: {
          name: 'OLED Hours Since Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:history'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_refresher',
        payload: {
          name: 'OLED Hours Until Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:update'
        }
      },
      {
        type: 'sensor', id: 'oled_compensation_status',
        payload: {
          name: 'OLED Compensation Status',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.comp_status if value_json.oled else "Unknown" }}',
          icon: 'mdi:autorenew'
        }
      },
      {
        type: 'sensor', id: 'oled_refresher_status',
        payload: {
          name: 'Pixel Refresher Status',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.refresher_status if value_json.oled else "Unknown" }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        /*
         * Both of these are settings rather than readings, so they carry their
         * own state and need no separate sensor. The panel protections beside
         * them - ASBL, GSR - are hardware behaviour and stay read-only.
         */
        type: 'switch', id: 'oled_screen_shift',
        payload: {
          name: 'OLED Screen Shift',
          command_topic: pfx + '/command/screenShift',
          state_topic: telemetryTopic,
          value_template: '{{ ("ON" if value_json.oled.screen_shift == "on" else "OFF") if value_json.oled and value_json.oled.screen_shift else none }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:arrow-all'
        }
      },
      {
        type: 'select', id: 'oled_logo_dimming',
        payload: {
          name: 'OLED Logo Dimming',
          command_topic: pfx + '/command/logoDimming',
          state_topic: telemetryTopic,
          // LG calls the strongest setting "strong"; the TV's own menu shows it
          // as High, and so does the dashboard.
          options: ['Off', 'Light', 'High'],
          command_template: '{{ {"Off":"off","Light":"light","High":"strong"}[value] }}',
          value_template: '{{ {"off":"Off","light":"Light","strong":"High"}.get(value_json.oled.logo_dimming, "Off") if value_json.oled and value_json.oled.logo_dimming else none }}',
          icon: 'mdi:television-guide'
        }
      },
      {
        type: 'sensor', id: 'oled_short_cycles',
        payload: {
          name: 'OLED Short Cycles Completed',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.comp_cycles if value_json.oled and value_json.oled.comp_cycles is not none else none }}',
          state_class: 'total_increasing',
          entity_category: 'diagnostic',
          icon: 'mdi:counter'
        }
      },
      {
        type: 'sensor', id: 'oled_refresher_cycles',
        payload: {
          name: 'OLED Refresher Cycles Completed',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.refresher_cycles if value_json.oled and value_json.oled.refresher_cycles is not none else none }}',
          state_class: 'total_increasing',
          entity_category: 'diagnostic',
          icon: 'mdi:counter'
        }
      },
      {
        type: 'sensor', id: 'oled_failure_alerts',
        payload: {
          name: 'OLED Compensation Failures',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.failure_alerts if value_json.oled and value_json.oled.failure_alerts is not none else 0 }}',
          entity_category: 'diagnostic',
          icon: 'mdi:alert-circle-outline'
        }
      },
      {
        type: 'binary_sensor', id: 'oled_asbl_dimmer',
        payload: {
          name: 'OLED ASBL Protection',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.oled and value_json.oled.asbl_protection == "Active" else "OFF" }}',
          entity_category: 'diagnostic',
          icon: 'mdi:shield-check'
        }
      },
      {
        type: 'switch', id: 'pixel_refresher_schedule',
        payload: {
          name: 'Schedule Pixel Refresher',
          command_topic: pfx + '/command/refresher',
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.oled and value_json.oled.refresher_status == \'Scheduled\' else \'OFF\' }}',
          payload_on: 'schedule',
          payload_off: 'cancel',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'select', id: 'picture_mode',
        payload: withSelect({
          name: 'Picture Mode',
          command_topic: pfx + '/command/picture_mode',
          state_topic: telemetryTopic,
          icon: 'mdi:image-filter-black-white'
        /* The settable modes depend on the dynamic range of what is playing,
           so this is whatever the TV last said it would accept. Discovery is
           republished when that set changes - see publishTelemetry. */
        }, namedSelect(lastPicModes.length
            ? lastPicModes.map(function (m) { return m.value; })
            : ['expert1', 'expert2', 'cinema', 'game', 'standard', 'eco', 'sports'],
          PIC_MODE_MAP, '(value_json.picture.mode_raw if value_json.picture else "standard")'))
      },
      {
        type: 'select', id: 'energy_saving',
        payload: {
          name: 'Energy Saving Step',
          command_topic: pfx + '/command/energySaving',
          state_topic: energySavingTopic,
          options: ['auto', 'off', 'min', 'med', 'max', 'screen_off'],
          icon: 'mdi:brightness-auto'
        }
      },
      {
        type: 'select', id: 'sound_output',
        payload: withSelect({
          name: 'Sound Output',
          command_topic: pfx + '/command/sound_output',
          state_topic: telemetryTopic,
          icon: 'mdi:speaker'
        }, namedSelect(Object.keys(SOUND_OUTPUT_MAP), SOUND_OUTPUT_MAP,
          '(value_json.sound.output_raw if value_json.sound else "tv_speaker")'))
      },
      {
        type: 'select', id: 'app',
        payload: (function () {
          var byId = appNames(installedApps);
          var toId = {};
          for (var id in byId) toId[byId[id]] = id;
          return {
            name: 'Launch App',
            command_topic: pfx + '/command/launch_app',
            // A name outside the list goes through as written, so an app id
            // sent by an older automation still launches.
            command_template: '{{ ' + JSON.stringify(toId) + '.get(value, value) }}',
            state_topic: telemetryTopic,
            value_template: '{{ ' + JSON.stringify(byId) + '.get(value_json.app_id, "None") }}',
            options: Object.keys(toId),
            icon: 'mdi:apps'
          };
        })()
      },
      {
        /*
         * Sleep timer. 15 is not an accepted value even though it looks like
         * one - the settings service rejects it. Valid: off, 10, 30, 60, 90, 120.
         */
        type: 'sensor', id: 'gpu_clock',
        payload: {
          name: 'GPU Clock', state_topic: telemetryTopic,
          value_template: '{{ value_json.gpuMhz if value_json.gpuMhz else none }}',
          unit_of_measurement: 'MHz', state_class: 'measurement', icon: 'mdi:expansion-card'
        }
      },
      {
        type: 'sensor', id: 'panel_dimming',
        payload: {
          name: 'Panel Dimming', state_topic: telemetryTopic,
          value_template: '{{ value_json.dimming }}', icon: 'mdi:brightness-auto'
        }
      },
      {
        type: 'sensor', id: 'app_storage_free',
        payload: {
          name: 'App Storage Free', state_topic: telemetryTopic,
          value_template: '{{ (value_json.appStorage.freeMb / 1024) | round(1) if value_json.appStorage else none }}',
          unit_of_measurement: 'GB', state_class: 'measurement', icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'ambient_light',
        payload: {
          name: 'Ambient Light', state_topic: telemetryTopic,
          value_template: '{{ value_json.lightSensor.lux if value_json.lightSensor else none }}',
          device_class: 'illuminance', state_class: 'measurement', icon: 'mdi:brightness-5'
        }
      },
      {
        type: 'select', id: 'sleep_timer',
        payload: {
          name: 'Sleep Timer',
          command_topic: pfx + '/command/sleepTimer',
          state_topic: telemetryTopic,
          options: ['Off', '10 min', '30 min', '60 min', '90 min', '120 min'],
          command_template: '{{ {"Off":"off","10 min":"10","30 min":"30","60 min":"60","90 min":"90","120 min":"120"}[value] }}',
          value_template: '{{ {"off":"Off","10":"10 min","30":"30 min","60":"60 min","90":"90 min","120":"120 min"}.get(value_json.sleepTimer, "Off") }}',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'switch', id: 'standby_light',
        payload: {
          name: 'Standby LED',
          command_topic: pfx + '/command/standbyLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.standby else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:led-on'
        }
      },
      {
        type: 'switch', id: 'logo_light',
        payload: {
          name: 'Logo Light',
          command_topic: pfx + '/command/logoLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.logo else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'button', id: 'screensaver',
        payload: {
          name: 'Start Screensaver',
          command_topic: pfx + '/command/screensaver',
          payload_press: 'press',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        /*
         * The other half of that button. turnOnScreenSaver reports success
         * whether or not anything answered the request, so this is the only
         * confirmation that one is actually on screen.
         */
        type: 'binary_sensor', id: 'screen_saver_active',
        payload: {
          name: 'Screen Saver',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.screenSaver else "OFF" }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'select', id: 'screensaver_mode',
        payload: {
          name: 'Screen Saver',
          command_topic: pfx + '/command/screensaverMode',
          state_topic: telemetryTopic,
          options: SS_IDS.map(function (k) { return SS[k].label; }),
          command_template: '{{ ' + JSON.stringify(ssMap(true)) + '[value] }}',
          value_template: '{{ ' + JSON.stringify(ssMap(false)) + '.get(value_json.screensaverMode, "LG default") }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'switch', id: 'ad_blocker',
        payload: {
          name: 'Ad & Telemetry Blocker',
          command_topic: pfx + '/command/adblock',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.privacy and value_json.privacy.adblock and value_json.privacy.adblock.enabled else "OFF" }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:shield-check'
        }
      },
      {
        type: 'button', id: 'play',
        payload: {
          name: 'Play',
          command_topic: pfx + '/command/playback',
          payload_press: 'play',
          icon: 'mdi:play'
        }
      },
      {
        type: 'button', id: 'pause',
        payload: {
          name: 'Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'pause',
          icon: 'mdi:pause'
        }
      },
      {
        type: 'button', id: 'play_pause',
        payload: {
          name: 'Play / Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'playPause',
          icon: 'mdi:play-pause'
        }
      },
      {
        type: 'button', id: 'stop',
        payload: {
          name: 'Stop',
          command_topic: pfx + '/command/playback',
          payload_press: 'stop',
          icon: 'mdi:stop'
        }
      }
    ];

    var updatePayload = {
      name: 'Server Update',
      state_topic: updateTopic,
      icon: 'mdi:package-up'
    };
    // Without a command topic Home Assistant shows the release but no Install
    // button, which is right where the Homebrew Channel does the updating.
    if (!opts.updatesElsewhere) {
      updatePayload.command_topic = pfx + '/command/update';
      updatePayload.payload_install = 'install';
    }
    entities.push({ type: 'update', id: 'server_update', payload: updatePayload });

    if (opts.allowPower) {
      entities.push({
        type: 'button', id: 'restart',
        payload: {
          name: 'Restart TV',
          command_topic: pfx + '/command/reboot',
          device_class: 'restart',
          icon: 'mdi:restart'
        }
      });
      entities.push({
        type: 'button', id: 'power_off',
        payload: {
          name: 'Power Off TV',
          command_topic: pfx + '/command/powerOff',
          icon: 'mdi:power'
        }
      });
    }

  return entities;
}

function filterWithholds(entities, opts) {
  opts = opts || {};
  var discPfx = opts.discPfx || 'homeassistant';
  var devId = opts.devId || 'lg_tv';
  var publishFn = opts.publishFn;
  var caps = opts.capabilities || {};

  function withhold(matches) {
    var kept = [], dropped = 0;
    for (var w = 0; w < entities.length; w++) {
      if (matches(entities[w])) {
        if (publishFn) {
          publishFn(discPfx + '/' + entities[w].type + '/' + devId + '/' +
                    entities[w].id + '/config', '', true);
        }
        dropped++;
      } else {
        kept.push(entities[w]);
      }
    }
    entities = kept;
    return dropped;
  }

  function byId() {
    var set = {}, a;
    for (a = 0; a < arguments.length; a++) set[arguments[a]] = 1;
    return function (e) { return set[e.id] === 1; };
  }

  if (!caps.hasRemoteInfo) withhold(byId('remote_battery'));

  if (!caps.hasPnwash) {
    withhold(byId('oled_short_cycles', 'oled_refresher_cycles', 'oled_failure_alerts'));
  }

  if (!caps.hasCell) withhold(byId('oled_cell_type', 'tcon_firmware'));

  if (!caps.hasHdmiProc) {
    withhold(function (e) { return e.id.indexOf('hdmi_') === 0; });
  }

  if (!caps.hasMediaState) withhold(byId('play_state'));

  if (!caps.hasHdrStatus) withhold(byId('video_colorimetry'));

  if (!caps.socArch) withhold(byId('soc_architecture'));

  if (caps.hasLogoLight === false) withhold(byId('logo_light'));

  if (!caps.thermalPresent) withhold(byId('soc_temperature'));

  if (!caps.emmcWearPresent) withhold(byId('flash_health', 'flash_wear'));

  if (!caps.hasLightSensor) withhold(byId('ambient_light'));

  if (!caps.updateCheck) withhold(byId('server_update'));

  var hdmiSeen = caps.hdmiSeen || {};
  withhold(function (e) {
    var needs = HDMI_DIAG_ONLY[e.id];
    return !!needs && !hdmiSeen[needs];
  });

  if (!caps.hasGpuClock) withhold(byId('gpu_clock'));

  if (caps.isOled === true) withhold(byId('panel_dimming'));

  if (caps.isOled === false) {
    var oledWithheld = withhold(function (e) { return OLED_ONLY[e.id] === 1; });
    if (oledWithheld > 0) {
      console.log('mqtt: not an OLED panel, withheld ' + oledWithheld + ' panel entities');
    }
  }

  var userEnts = caps.userEntities || {};
  var userWithheld = withhold(function (e) {
    var cat = entityCategory(e);
    if (userEnts[cat] === false) return true;
    var dis = userEnts.disabled;
    if (dis && (dis.indexOf(e.id) !== -1 || dis.indexOf(e.type + '.' + e.id) !== -1)) return true;
    return false;
  });
  if (userWithheld > 0) {
    console.log('mqtt: user configuration withheld ' + userWithheld + ' entities');
  }

  return entities;
}

module.exports = {
  INPUTS: INPUTS,
  SOUND_OUTPUT_MAP: SOUND_OUTPUT_MAP,
  PIC_MODE_MAP: PIC_MODE_MAP,
  HA_CATEGORIES: HA_CATEGORIES,
  HA_ENTITIES: HA_ENTITIES,
  ENTITY_CATEGORIES: ENTITY_CATEGORIES,
  entityCategory: entityCategory,
  selectState: selectState,
  appNames: appNames,
  RETIRED_ENTITIES: RETIRED_ENTITIES,
  HDMI_DIAG_ONLY: HDMI_DIAG_ONLY,
  OLED_ONLY: OLED_ONLY,
  clearRetired: clearRetired,
  buildEntities: buildEntities,
  filterWithholds: filterWithholds
};
