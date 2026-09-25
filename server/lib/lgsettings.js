/*
 * LG's own settings shown as a switch, a choice or a number, one row each.
 *
 * A row names the key in LG's settings service, its category, and the values
 * LG stores: for a switch, those for on and off; for a choice, each value
 * with its label; for a number, the range. store: 'string' is for a number
 * LG keeps as text, as it does the sound settings.
 *
 * port and column place an HDMI input's rows in the dashboard's table.
 *
 * greyable: LG greys out an HDMI input's settings while another input is on
 * screen, and these follow that. It greys other settings too - sound mode
 * while sound is not on the TV speakers - which stay changeable here.
 *
 * unless: another key in the same category that, where the TV has it, takes
 * this row's place - a C2 keeps one Deep Colour for the input on screen, and
 * still reports the per-port keys a B8 uses, set to off and unused.
 *
 * Choices and ranges differ between TVs - a B8 has six sound modes where a C2
 * has eight - so each is narrowed to what the TV's settings service describes
 * as visible. It is offered only where the TV reports the key,
 * so a TV without one (a B8 has no screen saver promotion) does not show it.
 * Adding a setting is adding a row here, with its strings; both dashboards
 * render the rows as they come.
 *
 * Each category is read whole, one call for all its rows: asking for a key
 * the TV does not have fails the whole call on some firmware.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var msg = require('./say').msg;

// LG's ads and promotions. Each is 'on' when the ads show; the names and
// meanings are those of LG's own Settings menu on webOS 22.
var ROWS = [
  { id: 'screenSaverAd', section: 'promotions', category: 'general', key: 'screenSaverAd', on: 'on', off: 'off',
    title: msg('srv.lgs.screenSaverAd', 'Screen saver ads'),
    desc: msg('srv.lgs.screenSaverAd.desc', 'Adverts that some apps, such as LG Channels, show in the screen saver. LG calls this Screen Saver Promotion.') },
  { id: 'homePromotion', section: 'promotions', category: 'general', key: 'homePromotion', on: 'on', off: 'off',
    title: msg('srv.lgs.homePromotion', 'Sponsored tiles on Home'),
    desc: msg('srv.lgs.homePromotion.desc', 'Adverts marked Sponsored on the Home screen. LG calls this Home Promotion.') },
  { id: 'contentRecommendation', section: 'promotions', category: 'other', key: 'contentRecommendation', on: 'on', off: 'off',
    title: msg('srv.lgs.contentRecommendation', 'Recommendations on Home'),
    desc: msg('srv.lgs.contentRecommendation.desc', 'Rows of recommended programmes and films on the Home screen. LG calls this Content Recommendation.') },
  { id: 'livePromotion', section: 'promotions', category: 'option', key: 'livePromotion', on: 'on', off: 'off',
    title: msg('srv.lgs.livePromotion', 'Ads while watching'),
    desc: msg('srv.lgs.livePromotion.desc', 'Adverts and offers shown over what is on screen, while LG\'s Live Plus is on. LG calls this Live Promotion.') },
  { id: 'aiNudge', section: 'promotions', category: 'general', key: 'aiNudge', on: 'on', off: 'off',
    title: msg('srv.lgs.aiNudge', 'Smart tips'),
    desc: msg('srv.lgs.aiNudge.desc', 'Suggestions for TV features that pop up while watching or using an app. LG calls this Smart Tips.') },
  { id: 'aiSettingsNudge', section: 'promotions', category: 'general', key: 'aiSettingsNudge', on: 'on', off: 'off',
    title: msg('srv.lgs.aiSettingsNudge', 'Smart tips in Settings'),
    desc: msg('srv.lgs.aiSettingsNudge.desc', 'Suggested settings shown in LG\'s Settings menu. LG calls this Smart Tips in Settings.') },

  // LG's Game Optimizer, from its own app on webOS 22. LG keeps these for the
  // game input and genre in use, which it reports as the category's
  // dimension, and applies them while the picture mode is Game Optimizer.
  { id: 'gameGenre', section: 'game', category: 'other', key: 'gameGenre', type: 'choice',
    choices: [
      { value: 'Standard', label: msg('srv.lgs.gameGenre.standard', 'Standard') },
      { value: 'FPS', label: msg('srv.lgs.gameGenre.fps', 'First-person shooter') },
      { value: 'RPG', label: msg('srv.lgs.gameGenre.rpg', 'Role-playing') },
      { value: 'RTS', label: msg('srv.lgs.gameGenre.rts', 'Real-time strategy') },
      { value: 'Sports', label: msg('srv.lgs.gameGenre.sports', 'Sports') },
      { value: 'USER', label: msg('srv.lgs.gameGenre.user', 'User') }
    ],
    title: msg('srv.lgs.gameGenre', 'Game genre'),
    desc: msg('srv.lgs.gameGenre.desc', 'Tunes the picture for the kind of game. Each genre keeps its own stabilizer settings.') },
  { id: 'inputOptimization', section: 'game', category: 'other', key: 'inputOptimization', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.inputOptimization.auto', 'Standard') },
      { value: 'on', label: msg('srv.lgs.inputOptimization.on', 'Boost') }
    ],
    title: msg('srv.lgs.inputOptimization', 'Prevent input delay'),
    desc: msg('srv.lgs.inputOptimization.desc', 'Standard cuts input lag for the kind of content; Boost cuts it further by matching the console\'s frame rate.') },
  { id: 'gameOptimization', section: 'game', category: 'other', key: 'gameOptimization', on: 'on', off: 'off',
    title: msg('srv.lgs.gameOptimization', 'VRR & G-Sync'),
    desc: msg('srv.lgs.gameOptimization.desc', 'Lets the TV follow the frame rate a console or PC sends, so motion stays smooth without tearing.') },
  { id: 'freesync', section: 'game', category: 'other', key: 'freesync', on: 'on', off: 'off',
    title: msg('srv.lgs.freesync', 'AMD FreeSync Premium'),
    desc: msg('srv.lgs.freesync.desc', 'The same for AMD graphics cards and consoles that use FreeSync.') },
  { id: 'enableALLM', section: 'game', category: 'other', key: 'enableALLM', on: 'on', off: 'off',
    title: msg('srv.lgs.enableALLM', 'ALLM'),
    desc: msg('srv.lgs.enableALLM.desc', 'Switches the TV to its low-latency game mode by itself when a connected device starts a game.') },
  { id: 'darkMode', section: 'game', category: 'other', key: 'darkMode', type: 'choice',
    choices: [
      { value: 'off', label: msg('srv.lgs.darkMode.off', 'Off') },
      { value: 'level1', label: msg('srv.lgs.darkMode.level1', 'Level 1') },
      { value: 'level2', label: msg('srv.lgs.darkMode.level2', 'Level 2') }
    ],
    title: msg('srv.lgs.darkMode', 'Dark room mode'),
    desc: msg('srv.lgs.darkMode.desc', 'Lowers the brightness for playing in a dark room.') },
  { id: 'blackStabilizer', section: 'game', category: 'other', key: 'blackStabilizer', type: 'number', min: 0, max: 20,
    title: msg('srv.lgs.blackStabilizer', 'Black stabilizer'),
    desc: msg('srv.lgs.blackStabilizer.desc', 'Lifts dark areas so detail in shadows is easier to see.') },
  { id: 'whiteStabilizer', section: 'game', category: 'other', key: 'whiteStabilizer', type: 'number', min: 0, max: 20,
    title: msg('srv.lgs.whiteStabilizer', 'White stabilizer'),
    desc: msg('srv.lgs.whiteStabilizer.desc', 'Tames bright areas so detail in highlights is easier to see.') },
  { id: 'aigamesound', section: 'game', category: 'sound', key: 'aigamesound', on: 'on', off: 'off',
    title: msg('srv.lgs.aigamesound', 'AI Game Sound'),
    desc: msg('srv.lgs.aigamesound.desc', 'Sets the sound for the game being played: effects, clear voices and surround.') },

  // Sound, as LG's Sound menu names it. The Control tab switches the output
  // too; it is here as well, beside the settings that depend on it.
  { id: 'soundOutput', section: 'sound', category: 'sound', key: 'soundOutput', type: 'choice',
    choices: [
      { value: 'tv_speaker', label: msg('srv.lgs.soundOutput.tvSpeaker', 'TV speakers') },
      { value: 'external_arc', label: msg('srv.lgs.soundOutput.externalArc', 'HDMI (ARC) device') },
      { value: 'external_optical', label: msg('srv.lgs.soundOutput.externalOptical', 'Optical out device') },
      { value: 'bt_soundbar', label: msg('srv.lgs.soundOutput.btSoundbar', 'Bluetooth device') },
      { value: 'headphone', label: msg('srv.lgs.soundOutput.headphone', 'Wired headphones') },
      { value: 'tv_speaker_external_arc', label: msg('srv.lgs.soundOutput.tvSpeakerExternalArc', 'HDMI (ARC) device and TV speakers') },
      { value: 'tv_speaker_bluetooth', label: msg('srv.lgs.soundOutput.tvSpeakerBluetooth', 'Bluetooth device and TV speakers') },
      { value: 'tv_speaker_headphone', label: msg('srv.lgs.soundOutput.tvSpeakerHeadphone', 'Wired headphones and TV speakers') }
    ],
    title: msg('srv.lgs.soundOutput', 'Sound output'),
    desc: msg('srv.lgs.soundOutput.desc', 'Where the TV plays its sound. Sound mode and balance apply only to the TV speakers.') },
  { id: 'soundMode', section: 'sound', category: 'sound', key: 'soundMode', type: 'choice',
    choices: [
      { value: 'aiSoundPlus', label: msg('srv.lgs.soundMode.aiSoundPlus', 'AI Sound Pro') },
      { value: 'aiSound', label: msg('srv.lgs.soundMode.aiSound', 'AI Sound') },
      { value: 'standard', label: msg('srv.lgs.soundMode.standard', 'Standard') },
      { value: 'news', label: msg('srv.lgs.soundMode.news', 'Clear Voice') },
      { value: 'movie', label: msg('srv.lgs.soundMode.movie', 'Cinema') },
      { value: 'sports', label: msg('srv.lgs.soundMode.sports', 'Sports') },
      { value: 'music', label: msg('srv.lgs.soundMode.music', 'Music') },
      { value: 'game', label: msg('srv.lgs.soundMode.game', 'Game Optimizer') }
    ],
    title: msg('srv.lgs.soundMode', 'Sound mode'),
    desc: msg('srv.lgs.soundMode.desc', 'How the TV tunes its sound, through its own speakers only. AI Sound Pro adjusts it to what is on by itself.') },
  { id: 'soundOutputDigital', section: 'sound', category: 'sound', key: 'soundOutputDigital', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.soundOutputDigital.auto', 'Auto') },
      { value: 'pcm', label: msg('srv.lgs.soundOutputDigital.pcm', 'PCM') },
      { value: 'passThrough', label: msg('srv.lgs.soundOutputDigital.passThrough', 'Pass Through') }
    ],
    title: msg('srv.lgs.soundOutputDigital', 'Digital sound output'),
    desc: msg('srv.lgs.soundOutputDigital.desc', 'The audio sent to a soundbar or receiver over HDMI ARC or optical. Pass Through sends Dolby and DTS as they are; PCM turns them into plain stereo.') },
  { id: 'audioBalance', section: 'sound', category: 'sound', key: 'audioBalance', type: 'number', min: -50, max: 50, store: 'string',
    title: msg('srv.lgs.audioBalance', 'Balance'),
    desc: msg('srv.lgs.audioBalance.desc', 'Between the left and right TV speakers, and only those. At 0 both play at the same level.') },
  { id: 'autoVolume', section: 'sound', category: 'sound', key: 'autoVolume', on: 'on', off: 'off',
    title: msg('srv.lgs.autoVolume', 'Automatic volume'),
    desc: msg('srv.lgs.autoVolume.desc', 'Keeps the volume level when switching channels. LG calls this Automatic Volume Adjustment.') },

  { id: 'eArcSupport', section: 'sound', category: 'sound', key: 'eArcSupport', on: 'on', off: 'off',
    title: msg('srv.lgs.eArcSupport', 'eARC'),
    desc: msg('srv.lgs.eArcSupport.desc', 'Sends lossless and Dolby Atmos audio to a soundbar or receiver on the HDMI (eARC) input, where both support it.') },

  // HDMI inputs. Deep Colour on a C2 is one setting, for the input on screen.
  { id: 'deepColor', section: 'hdmi', column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColor', type: 'choice',
    choices: [
      { value: 'off', label: msg('srv.lgs.deepColor.off', 'Off') },
      { value: 'on', label: msg('srv.lgs.deepColor.on', 'On') },
      { value: '4k', label: '4K' },
      { value: '8k', label: '8K' },
      { value: 'auto', label: msg('srv.lgs.deepColor.auto', 'Auto') }
    ],
    title: msg('srv.lgs.deepColor', 'HDMI Deep Colour'),
    desc: msg('srv.lgs.deepColor.desc', 'For the input on screen. Lets it take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change, and turning it off also turns off Game Optimizer for that input.') },
  { id: 'deepColorHDMI1', section: 'hdmi', port: 1, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI1', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi1', 'HDMI 1 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI2', section: 'hdmi', port: 2, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI2', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi2', 'HDMI 2 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI3', section: 'hdmi', port: 3, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI3', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi3', 'HDMI 3 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI4', section: 'hdmi', port: 4, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI4', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi4', 'HDMI 4 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'audioFormatHDMI1', section: 'hdmi', port: 1, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI1', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi1', 'HDMI 1 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream passes Dolby Atmos and DTS on to a soundbar or receiver; PCM asks for plain audio.') },
  { id: 'audioFormatHDMI2', section: 'hdmi', port: 2, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI2', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi2', 'HDMI 2 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream passes Dolby Atmos and DTS on to a soundbar or receiver; PCM asks for plain audio.') },
  { id: 'audioFormatHDMI3', section: 'hdmi', port: 3, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI3', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi3', 'HDMI 3 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream passes Dolby Atmos and DTS on to a soundbar or receiver; PCM asks for plain audio.') },
  { id: 'audioFormatHDMI4', section: 'hdmi', port: 4, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI4', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi4', 'HDMI 4 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream passes Dolby Atmos and DTS on to a soundbar or receiver; PCM asks for plain audio.') },

  // HDMI-CEC, which LG calls SIMPLINK.
  { id: 'simplinkEnable', section: 'devices', category: 'other', key: 'simplinkEnable', on: 'on', off: 'off',
    title: msg('srv.lgs.simplinkEnable', 'SIMPLINK (HDMI-CEC)'),
    desc: msg('srv.lgs.simplinkEnable.desc', 'Lets the TV remote control devices connected over HDMI, such as a soundbar or console.') },
  { id: 'simplinkAutoPowerOn', section: 'devices', category: 'other', key: 'simplinkAutoPowerOn', on: 'on', off: 'off',
    title: msg('srv.lgs.simplinkAutoPowerOn', 'Auto power sync'),
    desc: msg('srv.lgs.simplinkAutoPowerOn.desc', 'Switching the TV off switches connected devices off, and switching a device on switches the TV on.') },
  // The password LG keeps beside this, password_ipcontrol, is never read.
  { id: 'ipControl', section: 'devices', category: 'option', key: 'enableIpControl', on: 'on', off: 'off',
    title: msg('srv.lgs.ipControl', 'IP control'),
    desc: msg('srv.lgs.ipControl.desc', 'Lets home automation systems control the TV over the network with LG\'s own protocol. Off unless something needs it.') }
];

var luna = null;
var lunaCached = null;
var clearLunaCache = null;

function init(opts) {
  luna = opts.luna;
  lunaCached = opts.lunaCached;
  clearLunaCache = opts.clearLunaCache;
}

function rowById(id) {
  for (var i = 0; i < ROWS.length; i++) if (ROWS[i].id === id) return ROWS[i];
  return null;
}

// desc: what the TV's settings service describes for the key, if it was asked.
function rowValue(r, v, desc) {
  var out = { id: r.id, section: r.section, type: r.type || 'switch', title: r.title, desc: r.desc };
  if (r.port) out.port = r.port;
  if (r.column) out.column = r.column;
  if (r.greyable && desc && desc.active === false) out.active = false;
  if (out.type === 'switch') out.on = v === r.on;
  else out.value = r.store === 'string' ? Number(v) : v;
  if (r.choices) {
    var shown = desc && desc.arrayExt;
    out.choices = shown ? r.choices.filter(function (c) {
      for (var i = 0; i < shown.length; i++) if (shown[i].value === c.value && shown[i].visible !== false) return true;
      return false;
    }) : r.choices;
    // A value set outside this list, such as another output from LG's menu,
    // is shown by its own name rather than as the first choice.
    var known = false;
    for (var k = 0; k < out.choices.length; k++) if (out.choices[k].value === v) known = true;
    if (!known) out.choices = out.choices.concat([{ value: v, label: String(v) }]);
  }
  if (out.type === 'number') {
    out.min = desc && typeof desc.min === 'number' ? desc.min : r.min;
    out.max = desc && typeof desc.max === 'number' ? desc.max : r.max;
  }
  return out;
}

// Every row in a section the TV has, with its value now, and the dimension LG
// reports for each category: the game input and genre the game rows belong to.
function collect(section, cb) {
  var sections = [].concat(section);
  var rows = ROWS.filter(function (r) { return sections.indexOf(r.section) !== -1; });
  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  var values = {};
  var dims = {};
  var descs = {};
  var i = 0;
  (function next() {
    if (i >= cats.length) {
      var out = [];
      rows.forEach(function (r) {
        var v = values[r.category] && values[r.category][r.key];
        if (v === undefined) return;
        if (r.unless && values[r.category][r.unless] !== undefined) return;
        out.push(rowValue(r, v, descs[r.category] && descs[r.category][r.key]));
      });
      return cb({ ok: true, rows: out, dimensions: dims });
    }
    var cat = cats[i++];
    lunaCached('com.webos.service.settings/getSystemSettings', { category: cat }, 30000, function (res) {
      values[cat] = (res && res.returnValue !== false && res.settings) || {};
      if (res && res.dimension) dims[cat] = res.dimension;
      // The values a choice or number may take on this TV, and whether it can
      // be changed now, which follows the input on screen.
      var keys = rows.filter(function (r) { return r.category === cat; })
                     .map(function (r) { return r.key; })
                     .filter(function (k) { return values[cat][k] !== undefined; });
      if (!keys.length) return next();
      lunaCached('com.webos.service.settings/getSystemSettingDesc', { category: cat, keys: keys }, 30000, function (d) {
        descs[cat] = {};
        ((d && d.results) || []).forEach(function (x) {
          var vs = x.values || {};
          var d = vs.arrayExt ? { arrayExt: vs.arrayExt } : { min: vs.min, max: vs.max };
          // LG greys out a setting it cannot change now, such as Deep Colour
          // while the TV is not on an HDMI input.
          d.active = !(x.ui && x.ui.active === false);
          descs[cat][x.key] = d;
        });
        next();
      });
    });
  })();
}

// value: true or false for a switch, one of the row's values for a choice,
// a whole number in range for a number.
function set(id, value, cb) {
  var r = rowById(id);
  if (!r) return cb({ ok: false, error: msg('srv.lgsettings.unknown', 'Unknown setting') });
  var type = r.type || 'switch';
  var stored;
  if (type === 'switch') stored = value === true ? r.on : r.off;
  else if (type === 'choice') {
    for (var c = 0; c < r.choices.length; c++) if (r.choices[c].value === value) stored = value;
  } else if (typeof value === 'number' && value % 1 === 0 && value >= r.min && value <= r.max) stored = value;
  if (stored === undefined) return cb({ ok: false, error: msg('srv.lgsettings.badValue', 'That value is not one this setting takes') });
  if (r.store === 'string') stored = String(stored);
  var settings = {};
  settings[r.key] = stored;
  /*
   * LG's menu greys out an HDMI input's settings while another input is on
   * screen, but its settings service stores a write regardless (a C2 did, on
   * webOS 22). So for those the greying is checked here, fresh, and honoured.
   */
  luna('com.webos.service.settings/getSystemSettingDesc', { category: r.category, keys: [r.key] }, function (d) {
    var x = d && d.results && d.results[0];
    if (r.greyable && x && x.ui && x.ui.active === false) {
      return cb({ ok: false, error: msg('lgs.inactive', 'Not available with the TV’s current input or sound output.') });
    }
    luna('com.webos.service.settings/setSystemSettings', { category: r.category, settings: settings }, function (res) {
      clearLunaCache();
      cb({ ok: !!(res && res.returnValue) });
    });
  });
}

module.exports = {
  init: init,
  collect: collect,
  set: set,
  ROWS: ROWS
};
