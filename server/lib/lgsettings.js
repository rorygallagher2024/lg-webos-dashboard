/*
 * LG's own settings shown as a switch, a choice or a number, one row each.
 *
 * A row names the key in LG's settings service, its category, and the values
 * LG stores: for a switch, those for on and off; for a choice, each value
 * with its label; for a number, the range. It is offered only where the TV reports the key,
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
    desc: msg('srv.lgs.aigamesound.desc', 'Sets the sound for the game being played: effects, clear voices and surround.') }
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

function rowValue(r, v) {
  var out = { id: r.id, section: r.section, type: r.type || 'switch', title: r.title, desc: r.desc };
  if (out.type === 'switch') out.on = v === r.on;
  else out.value = v;
  if (r.choices) out.choices = r.choices;
  if (out.type === 'number') { out.min = r.min; out.max = r.max; }
  return out;
}

// Every row in a section the TV has, with its value now, and the dimension LG
// reports for each category: the game input and genre the game rows belong to.
function collect(section, cb) {
  var rows = ROWS.filter(function (r) { return r.section === section; });
  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  var values = {};
  var dims = {};
  var i = 0;
  (function next() {
    if (i >= cats.length) {
      var out = [];
      rows.forEach(function (r) {
        var v = values[r.category] && values[r.category][r.key];
        if (v === undefined) return;
        out.push(rowValue(r, v));
      });
      return cb({ ok: true, rows: out, dimensions: dims });
    }
    var cat = cats[i++];
    lunaCached('com.webos.service.settings/getSystemSettings', { category: cat }, 30000, function (res) {
      values[cat] = (res && res.returnValue !== false && res.settings) || {};
      if (res && res.dimension) dims[cat] = res.dimension;
      next();
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
  var settings = {};
  settings[r.key] = stored;
  luna('com.webos.service.settings/setSystemSettings', { category: r.category, settings: settings }, function (res) {
    clearLunaCache();
    cb({ ok: !!(res && res.returnValue) });
  });
}

module.exports = {
  init: init,
  collect: collect,
  set: set,
  ROWS: ROWS
};
