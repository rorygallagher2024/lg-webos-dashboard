/*
 * LG's own settings shown as a plain switch, one row each.
 *
 * A row names the key in LG's settings service, its category, and the values
 * LG stores for on and off. It is offered only where the TV reports the key,
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
    desc: msg('srv.lgs.aiSettingsNudge.desc', 'Suggested settings shown in LG\'s Settings menu. LG calls this Smart Tips in Settings.') }
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

// Every row the TV has, with whether it is on now.
function collect(cb) {
  var cats = [];
  ROWS.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  var values = {};
  var i = 0;
  (function next() {
    if (i >= cats.length) {
      var out = [];
      ROWS.forEach(function (r) {
        var v = values[r.category] && values[r.category][r.key];
        if (v === undefined) return;
        out.push({ id: r.id, section: r.section, title: r.title, desc: r.desc, on: v === r.on });
      });
      return cb({ ok: true, rows: out });
    }
    var cat = cats[i++];
    lunaCached('com.webos.service.settings/getSystemSettings', { category: cat }, 30000, function (res) {
      values[cat] = (res && res.returnValue !== false && res.settings) || {};
      next();
    });
  })();
}

function set(id, on, cb) {
  var r = rowById(id);
  if (!r) return cb({ ok: false, error: msg('srv.lgsettings.unknown', 'Unknown setting') });
  var settings = {};
  settings[r.key] = on ? r.on : r.off;
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
