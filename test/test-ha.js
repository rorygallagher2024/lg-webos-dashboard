/**
 * test/test-ha.js - Unit tests for Home Assistant MQTT discovery payloads and filtering
 */

var assert = require('assert');
var ha = require('../server/lib/ha');

console.log('Running test-ha.js ...');

// 1. Categories and catalog integrity
(function testCategoriesIntegrity() {
  assert.strictEqual(Array.isArray(ha.HA_CATEGORIES), true);
  assert.strictEqual(ha.HA_CATEGORIES.length >= 4, true);

  var catMap = {};
  ha.HA_CATEGORIES.forEach(function (c) {
    assert.strictEqual(typeof c.id, 'string');
    assert.strictEqual(typeof c.name, 'string');
    assert.strictEqual(typeof c.desc, 'string');
    catMap[c.id] = true;
  });

  // Core categories exist
  assert.strictEqual(catMap.controls, true);
  assert.strictEqual(catMap.system, true);
  assert.strictEqual(catMap.oled, true);
  assert.strictEqual(catMap.video, true);
  assert.strictEqual(catMap.diagnostics, true);

  // Every entity in HA_ENTITIES maps to a valid category
  ha.HA_ENTITIES.forEach(function (ent) {
    assert.strictEqual(!!catMap[ent.cat], true, 'Entity ' + ent.id + ' maps to unknown category: ' + ent.cat);
  });

  // ENTITY_CATEGORIES index matches known categories
  for (var key in ha.ENTITY_CATEGORIES) {
    var cat = ha.ENTITY_CATEGORIES[key];
    assert.strictEqual(!!catMap[cat], true, 'Category mapping ' + key + ' maps to unknown category: ' + cat);
  }

  console.log('  ✓ Category definitions and entity catalogue are valid');
})();

// 2. buildEntities schema and structure
(function testBuildEntities() {
  var baseEntities = ha.buildEntities({
    pfx: 'home/tv',
    allowPower: false,
    installedApps: [
      { id: 'youtube', title: 'YouTube' },
      { id: 'netflix', title: 'Netflix' }
    ],
    pictureModes: [
      { value: 'cinema', label: 'Cinema' },
      { value: 'game', label: 'Game' }
    ]
  });

  assert.strictEqual(Array.isArray(baseEntities), true);
  assert.strictEqual(baseEntities.length > 50, true, 'Should build over 50 entities');

  var seenIds = {};
  baseEntities.forEach(function (e) {
    assert.strictEqual(typeof e.type, 'string', 'Entity type must be string: ' + JSON.stringify(e));
    assert.strictEqual(typeof e.id, 'string', 'Entity id must be string: ' + JSON.stringify(e));
    assert.strictEqual(typeof e.payload, 'object', 'Entity payload must be object: ' + e.id);
    assert.strictEqual(typeof e.payload.name, 'string', 'Entity name must be string: ' + e.id);

    var fullKey = e.type + '.' + e.id;
    assert.strictEqual(!seenIds[fullKey], true, 'Duplicate entity type.id: ' + fullKey);
    seenIds[fullKey] = true;

    // Verify entity category resolves
    var cat = ha.entityCategory(e);
    assert.strictEqual(typeof cat, 'string');
  });

  // Without allowPower, power control buttons must NOT be present
  assert.strictEqual(!seenIds['button.restart'], true);
  assert.strictEqual(!seenIds['button.power_off'], true);
  assert.strictEqual(!seenIds['button.power_on'], true);

  // With allowPower, power control buttons MUST be present
  var powerEntities = ha.buildEntities({
    pfx: 'home/tv',
    allowPower: true
  });
  var powerSeen = {};
  powerEntities.forEach(function (e) { powerSeen[e.type + '.' + e.id] = true; });
  assert.strictEqual(powerSeen['button.restart'], true);
  assert.strictEqual(powerSeen['button.power_off'], true);
  assert.strictEqual(powerSeen['button.power_on'], true);

  // Dynamic app select options
  var appEntity = null;
  baseEntities.forEach(function (e) { if (e.id === 'app') appEntity = e; });
  assert.strictEqual(!!appEntity, true);
  assert.strictEqual(Array.isArray(appEntity.payload.options), true);
  assert.strictEqual(appEntity.payload.options.indexOf('YouTube') !== -1, true);
  assert.strictEqual(appEntity.payload.options.indexOf('Netflix') !== -1, true);

  // Dynamic picture mode select options
  var picEntity = null;
  baseEntities.forEach(function (e) { if (e.id === 'picture_mode') picEntity = e; });
  assert.strictEqual(!!picEntity, true);
  assert.strictEqual(Array.isArray(picEntity.payload.options), true);
  assert.strictEqual(picEntity.payload.options.indexOf('Cinema') !== -1, true);
  assert.strictEqual(picEntity.payload.options.indexOf('Game') !== -1, true);

  console.log('  ✓ buildEntities generates unique, valid Home Assistant entities and dynamic options');
})();

// 3. filterWithholds capability filtering (OLED vs LCD, sensors, user configs)
(function testFilterWithholds() {
  function getEntities() {
    return ha.buildEntities({ pfx: 'test/tv', allowPower: true });
  }

  // OLED set
  var oledList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      hasMediaState: true,
      hasHdrStatus: true,
      socArch: 'aarch64',
      thermalPresent: true,
      emmcWearPresent: true,
      hasLightSensor: true,
      updateCheck: true,
      hasGpuClock: true
    }
  });
  var oledIds = {};
  oledList.forEach(function (e) { oledIds[e.id] = true; });
  assert.strictEqual(oledIds.oled_screen_shift, true, 'OLED must retain oled_screen_shift');
  assert.strictEqual(oledIds.oled_logo_dimming, true, 'OLED must retain oled_logo_dimming');
  assert.strictEqual(oledIds.pixel_refresher_schedule, true, 'OLED must retain pixel_refresher_schedule');
  assert.strictEqual(!oledIds.panel_dimming, true, 'OLED must withhold panel_dimming');

  // LCD set (non-OLED)
  var lcdList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: false,
      hasMediaState: true,
      hasHdrStatus: true,
      socArch: 'armv7l',
      thermalPresent: true,
      emmcWearPresent: true,
      hasLightSensor: true,
      updateCheck: true,
      hasGpuClock: true
    }
  });
  var lcdIds = {};
  lcdList.forEach(function (e) { lcdIds[e.id] = true; });
  assert.strictEqual(!lcdIds.oled_screen_shift, true, 'LCD must withhold oled_screen_shift');
  assert.strictEqual(!lcdIds.oled_logo_dimming, true, 'LCD must withhold oled_logo_dimming');
  assert.strictEqual(!lcdIds.pixel_refresher_schedule, true, 'LCD must withhold pixel_refresher_schedule');
  assert.strictEqual(lcdIds.panel_dimming, true, 'LCD must retain panel_dimming');

  // Missing sensors
  var missingSensorsList = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      thermalPresent: false,
      hasLightSensor: false,
      hasGpuClock: false
    }
  });
  var msIds = {};
  missingSensorsList.forEach(function (e) { msIds[e.id] = true; });
  assert.strictEqual(!msIds.soc_temperature, true, 'thermalPresent:false withholds soc_temperature');
  assert.strictEqual(!msIds.ambient_light, true, 'hasLightSensor:false withholds ambient_light');
  assert.strictEqual(!msIds.gpu_clock, true, 'hasGpuClock:false withholds gpu_clock');

  // User configuration withholding category or specific entity
  var userFiltered = ha.filterWithholds(getEntities(), {
    capabilities: {
      isOled: true,
      userEntities: {
        controls: false,
        disabled: ['cpu_load']
      }
    }
  });
  var ufIds = {};
  userFiltered.forEach(function (e) { ufIds[e.id] = true; });
  assert.strictEqual(!ufIds.volume, true, 'controls:false withholds volume');
  assert.strictEqual(!ufIds.mute, true, 'controls:false withholds mute');
  assert.strictEqual(!ufIds.cpu_load, true, 'disabled cpu_load withholds cpu_load');
  assert.strictEqual(ufIds.memory_usage, true, 'other categories remain untouched');

  console.log('  ✓ filterWithholds properly respects panel capabilities, hardware sensors, and user preferences');
})();

// 4. Select state mapping and appNames
(function testMappingsAndAppNames() {
  // selectState template generation
  var tmpl = ha.selectState('value_json.sound.output', ['TV Speaker', 'HDMI ARC']);
  assert.strictEqual(tmpl, "{{ (value_json.sound.output) if (value_json.sound.output) in ['TV Speaker', 'HDMI ARC'] else 'None' }}");

  // Output mappings
  assert.strictEqual(ha.SOUND_OUTPUT_MAP.tv_speaker, 'TV Speaker');
  assert.strictEqual(ha.SOUND_OUTPUT_MAP.external_arc, 'HDMI ARC');
  assert.strictEqual(ha.PIC_MODE_MAP.cinema, 'Cinema');

  // appNames deduplication and collision resolution
  var apps = [
    { id: 'app.one', title: 'Media Player' },
    { id: 'app.two', title: 'Media Player' },
    { id: 'app.three', title: 'Browser' }
  ];
  var mapped = ha.appNames(apps);
  assert.strictEqual(mapped['app.three'], 'Browser');
  assert.notStrictEqual(mapped['app.one'], mapped['app.two'], 'Duplicate titles must be disambiguated');
  assert.strictEqual(mapped['app.one'].indexOf('Media Player') !== -1, true);
  assert.strictEqual(mapped['app.two'].indexOf('Media Player') !== -1, true);

  console.log('  ✓ selectState mappings and appNames collision handling function correctly');
})();

console.log('ALL test-ha.js assertions passed!\n');
