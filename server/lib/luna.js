/*
 * Luna transport for one-shot calls and long-lived subscriptions.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var childProcess = require('child_process');
var execFile = childProcess.execFile;
var spawn = childProcess.spawn;

/*
 * One-shot calls run at most two at a time, the rest in turn. Node 0.12 on a
 * B8 (webOS 4) has frozen in its first second at start: a luna-send child
 * stuck between fork and exec on a lock it inherited held, the server waiting
 * on it, and every later child the same. Start fires off a burst of these
 * calls at once, which is when it happened. Subscriptions start once and stay
 * open, so they are not counted.
 */
var PARALLEL = 2;
var running = 0;
var waiting = [];

function pump() {
  while (running < PARALLEL && waiting.length) {
    var job = waiting.shift();
    running++;
    run(job);
  }
}

function run(job) {
  execFile('/usr/bin/luna-send', job.args, { timeout: 3500 }, function (err, stdout) {
    running--;
    pump();
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (job.cb) job.cb(parsed, String(stdout || ''));
  });
}

function call(uri, payload, cb, appId) {
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  waiting.push({ args: args, cb: cb });
  pump();
}

function Subscription(uri, payload, appId, handlers) {
  this.uri = uri;
  this.payload = payload || {};
  this.appId = appId;
  this.handlers = handlers || {};
  this.child = null;
  this.buffer = '';
  this.stopped = true;
  this.retryTimer = null;
  this.retryMs = 1000;
}

Subscription.prototype.start = function () {
  if (!this.stopped) return;
  this.stopped = false;
  this.retryMs = 1000;
  this._connect();
};

Subscription.prototype.stop = function () {
  this.stopped = true;
  if (this.retryTimer) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  if (this.child) {
    this.child.kill();
    this.child = null;
  }
  this.buffer = '';
};

Subscription.prototype._connect = function () {
  var self = this;
  if (self.stopped || self.child) return;

  var args = self.appId ? ['-a', self.appId] : [];
  // Formatted responses span several lines. Subscription responses are parsed
  // as one compact JSON response per line instead.
  args = args.concat(['-i', 'luna://' + self.uri, JSON.stringify(self.payload)]);
  self.buffer = '';
  self.child = spawn('/usr/bin/luna-send', args);

  self.child.stdout.on('data', function (chunk) {
    self._consume(String(chunk));
  });
  self.child.stderr.on('data', function (chunk) {
    if (self.handlers.error) self.handlers.error(String(chunk));
  });
  self.child.on('error', function (err) {
    if (self.handlers.error) self.handlers.error(err);
  });
  self.child.on('close', function (code, signal) {
    self.child = null;
    if (self.stopped) return;
    if (self.handlers.close) self.handlers.close(code, signal);
    self.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self._connect();
    }, self.retryMs);
    self.retryMs = Math.min(self.retryMs * 2, 30000);
  });
};

Subscription.prototype._consume = function (chunk) {
  var lines, i, line, parsed;
  this.buffer += chunk;
  lines = this.buffer.split(/\r?\n/);
  this.buffer = lines.pop();
  for (i = 0; i < lines.length; i++) {
    line = lines[i].replace(/^\s+|\s+$/g, '');
    if (!line) continue;
    try {
      parsed = JSON.parse(line);
      if (this.handlers.message) this.handlers.message(parsed);
    } catch (e) {
      if (this.handlers.error) this.handlers.error(e, line);
    }
  }
};

module.exports = {
  call: call,
  Subscription: Subscription
};
