/*
 * The live frame rate of a game, as LG's Game Optimizer shows it.
 *
 * utp.extinputs/bind returns the pipeline of the input on screen, and
 * getVRRInfo on that pipeline reports the frame rate once a second. The rate is
 * the game's own while the source is using VRR; otherwise it is the signal's
 * fixed rate (a console at 120 Hz with VRR off reads 120), and 0 with nothing
 * on the input.
 *
 * Both subscriptions are held only while a dashboard is asking, and dropped
 * IDLE_MS after the last request, so nothing is bound to the input otherwise.
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var luna = require('./luna');

var IDLE_MS = 15000;

var bindSub = null;
var vrrSub = null;
var pipeline = null;
var idleTimer = null;
var latest = { frameRate: 0, vrrType: 'off', port: null };

function watchPipeline(id) {
  if (vrrSub) vrrSub.stop();
  pipeline = id;
  latest = { frameRate: 0, vrrType: 'off', port: null };
  vrrSub = new luna.Subscription('com.webos.service.utp.extinputs/getVRRInfo',
    { subscribe: true, pipelineId: id, mode: 'GameOptimizer', interval: 1000 }, null, {
      message: function (r) {
        if (!r || !r.vrrInfo) return;
        latest = {
          frameRate: typeof r.vrrInfo.frameRate === 'number' ? r.vrrInfo.frameRate : 0,
          vrrType: r.vrrInfo.vrrType || 'off',
          port: r.port || null
        };
      }
    });
  vrrSub.start();
}

function start() {
  bindSub = new luna.Subscription('com.webos.service.utp.extinputs/bind', { subscribe: true }, null, {
    message: function (r) {
      // A new pipeline each time the input changes; none while nothing is bound.
      if (r && r.broadcastId && r.broadcastId !== pipeline) watchPipeline(r.broadcastId);
    }
  });
  bindSub.start();
}

function stop() {
  if (vrrSub) vrrSub.stop();
  if (bindSub) bindSub.stop();
  vrrSub = bindSub = pipeline = null;
  latest = { frameRate: 0, vrrType: 'off', port: null };
}

// The latest reading; starts watching if nothing was, and keeps it going.
function frameRate() {
  if (!bindSub) start();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  return { frameRate: latest.frameRate, vrrType: latest.vrrType, port: latest.port };
}

module.exports = {
  frameRate: frameRate,
  stop: stop
};
