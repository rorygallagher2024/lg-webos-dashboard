/*
 * Notices a TV that stays awake after being switched off.
 *
 * Switched off, a C2 sits in Active Standby for two or three minutes (about
 * 12 W) and then sleeps (about 0 W). LG's Always-on and Always Ready keep it
 * awake on purpose, and so does panel maintenance. On 2026-09-25 a C2 stayed
 * at 12.6 W with neither setting on until it was rebooted, and the cause was
 * not found, so this looks for the symptom rather than any one cause.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */

var STUCK_AFTER_MS = 15 * 60 * 1000;

var offSince = null;

// Called on each change of the TV's power state.
function noteState(raw, now) {
  if (raw !== 'Active Standby') offSince = null;
  else if (offSince === null) offSince = now;
}

// Whether a collectStats() result shows a TV that should be asleep by now.
function isStuck(stats, now) {
  if (offSince === null || now - offSince < STUCK_AFTER_MS) return false;
  if (!stats.powerState || stats.powerState.raw !== 'Active Standby') return false;
  if (stats.alwaysReady) return false;
  if (stats.lifeOnScreen && stats.lifeOnScreen !== 'off') return false;
  var o = stats.oled;
  if (o && (o.comp_status === 'Running' || o.refresher_status === 'Running')) return false;
  return true;
}

module.exports = {
  noteState: noteState,
  isStuck: isStuck,
  STUCK_AFTER_MS: STUCK_AFTER_MS
};
