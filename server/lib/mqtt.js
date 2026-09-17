/*
 * MiniMQTT - minimal zero-dependency MQTT 3.1.1 client for Node 0.12+.
 * ES5 only: runs on webOS TV Node runtime.
 */
var net = require('net');
var tls = require('tls');

function encodeVarLength(len) {
  var bytes = [];
  do {
    var digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit = digit | 0x80;
    bytes.push(digit);
  } while (len > 0);
  return (typeof Buffer.from === 'function') ? Buffer.from(bytes) : new Buffer(bytes);
}

function toBuffer(data, enc) {
  return (typeof Buffer.from === 'function') ? Buffer.from(data, enc) : new Buffer(data, enc);
}

function zeroBuffer(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}

function MiniMQTT(opts) {
  this.opts = opts || {};
  this.client = null;
  this.connected = false;
  this.packetId = 1;
  this.buffer = toBuffer([]);
  this.pingTimer = null;
  this.retryTimer = null;
  this.subscriptions = [];
  this.listeners = {};
}

MiniMQTT.prototype.on = function(event, fn) {
  this.listeners[event] = this.listeners[event] || [];
  this.listeners[event].push(fn);
};

MiniMQTT.prototype.emit = function(event, a, b) {
  var list = this.listeners[event] || [];
  for (var i = 0; i < list.length; i++) list[i](a, b);
};

MiniMQTT.prototype.connect = function() {
  var self = this;
  if (this.client) return;
  clearTimeout(this.retryTimer);

  /*
   * Start each connection on an empty buffer. A drop mid-packet - a broker
   * restart, a Wi-Fi blip - leaves a partial packet here, and the new
   * connection's CONNACK would be appended to that fragment. The parser reads
   * the remaining length from the fragment's bytes, waits for a packet that
   * never completes, and the client stays unconnected: publish() then silently
   * returns and the bridge goes quiet until the process restarts.
   */
  this.buffer = toBuffer([]);

  /*
   * Plain TCP by default, since that is what a typical home broker listens on.
   * With mqtt.tls set, connect over TLS instead - otherwise the username and
   * password cross the LAN in cleartext inside every CONNECT packet, and a
   * reconnect loop resends them every few seconds.
   */
  var socket;
  if (this.opts.tls) {
    socket = tls.connect({
      host: this.opts.host,
      port: this.opts.port || 8883,
      servername: this.opts.host,
      // Self-signed broker certs are common on home networks. Turning this
      // off keeps the traffic encrypted but stops authenticating the broker,
      // so only do it on a network you trust.
      rejectUnauthorized: this.opts.tlsRejectUnauthorized !== false
    });
  } else {
    socket = net.createConnection({ host: this.opts.host, port: this.opts.port || 1883 });
  }
  this.client = socket;

  socket.on(self.opts.tls ? 'secureConnect' : 'connect', function() {
    var protoName = toBuffer([0, 4, 77, 81, 84, 84]); // 'MQTT'
    var protoLevel = toBuffer([4]); // 3.1.1
    var flags = 0x02; // CleanSession
    if (self.opts.will) {
      flags |= 0x04; // Will flag
      if (self.opts.will.retain) flags |= 0x20;
    }
    if (self.opts.username) flags |= 0x80;
    if (self.opts.password) flags |= 0x40;

    var flagBuf = toBuffer([flags]);
    var keepAlive = toBuffer([0, 60]); // 60s
    var varHeader = Buffer.concat([protoName, protoLevel, flagBuf, keepAlive]);

    var payloads = [];
    var cid = self.opts.clientId || ('lgtv_' + Math.random().toString(16).slice(2, 8));
    var cidBuf = toBuffer(cid, 'utf8');
    var cidLen = toBuffer([cidBuf.length >> 8, cidBuf.length & 0xff]);
    payloads.push(cidLen, cidBuf);

    if (self.opts.will) {
      var wtBuf = toBuffer(self.opts.will.topic, 'utf8');
      payloads.push(toBuffer([wtBuf.length >> 8, wtBuf.length & 0xff]), wtBuf);
      var wmBuf = toBuffer(self.opts.will.payload || '', 'utf8');
      payloads.push(toBuffer([wmBuf.length >> 8, wmBuf.length & 0xff]), wmBuf);
    }

    if (self.opts.username) {
      var uBuf = toBuffer(self.opts.username, 'utf8');
      payloads.push(toBuffer([uBuf.length >> 8, uBuf.length & 0xff]), uBuf);
    }
    if (self.opts.password) {
      var pBuf = toBuffer(self.opts.password, 'utf8');
      payloads.push(toBuffer([pBuf.length >> 8, pBuf.length & 0xff]), pBuf);
    }

    var payload = Buffer.concat(payloads);
    var remLen = encodeVarLength(varHeader.length + payload.length);
    var packet = Buffer.concat([toBuffer([0x10]), remLen, varHeader, payload]);
    socket.write(packet);
  });

  socket.on('data', function(chunk) {
    self.buffer = Buffer.concat([self.buffer, chunk]);
    self._parse();
  });

  socket.on('close', function() {
    var wasConnected = self.connected;
    self.connected = false;
    self.client = null;
    clearInterval(self.pingTimer);
    if (wasConnected) {
      console.log('mqtt: disconnected from ' + self.opts.host + ':' + (self.opts.port || (self.opts.tls ? 8883 : 1883)));
      self.emit('close');
    }
    self.retryTimer = setTimeout(function() { self.connect(); }, 5000);
  });

  socket.on('error', function(err) {
    self.emit('error', err);
    if (self.client) {
      self.client.destroy();
    }
  });
};

MiniMQTT.prototype._parse = function() {
  while (this.buffer.length >= 2) {
    var packetType = this.buffer[0] >> 4;
    var flags = this.buffer[0] & 0x0f;
    var multiplier = 1, remLen = 0, idx = 1, digit;
    do {
      if (idx >= this.buffer.length) return; // wait for more data
      digit = this.buffer[idx++];
      remLen += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    var totalLen = idx + remLen;
    if (this.buffer.length < totalLen) return; // wait for full packet

    var packetBody = this.buffer.slice(idx, totalLen);
    this.buffer = this.buffer.slice(totalLen);

    if (packetType === 2) { // CONNACK
      var returnCode = packetBody[1];
      if (returnCode === 0) {
        this.connected = true;
        var self = this;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(function() {
          if (self.client && self.connected) {
            self.client.write(toBuffer([0xc0, 0x00])); // PINGREQ
          }
        }, 30000);
        // Resubscribe to all saved subscriptions
        for (var i = 0; i < this.subscriptions.length; i++) {
          this._sendSubscribe(this.subscriptions[i]);
        }
        this.emit('connect');
      } else {
        this.emit('error', new Error('CONNACK rejected with code ' + returnCode));
      }
    } else if (packetType === 3) { // PUBLISH
      var qos = (flags >> 1) & 0x03;
      var tLen = (packetBody[0] << 8) | packetBody[1];
      var topic = packetBody.slice(2, 2 + tLen).toString('utf8');
      var pOffset = 2 + tLen;
      if (qos > 0) {
        /*
         * Subscriptions are made at QoS 0 and a broker may not deliver above
         * the granted QoS, so this should never arrive. If one does, a QoS 1
         * message left unacknowledged is redelivered on a timer for as long as
         * the session lasts, so answer it rather than drop it silently.
         */
        if (qos === 1 && this.client) {
          this.client.write(toBuffer([0x40, 0x02, packetBody[pOffset], packetBody[pOffset + 1]]));
        }
        pOffset += 2;   // past the packet identifier
      }
      var payload = packetBody.slice(pOffset).toString('utf8');
      this.emit('message', topic, payload);
    }
  }
};

MiniMQTT.prototype._sendSubscribe = function(topic) {
  if (!this.client || !this.connected) return;
  var pid = this.packetId++;
  if (this.packetId > 65535) this.packetId = 1;
  var pidBuf = toBuffer([pid >> 8, pid & 0xff]);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var qosBuf = toBuffer([0]);
  var payload = Buffer.concat([pidBuf, tLen, tBuf, qosBuf]);
  var remLen = encodeVarLength(payload.length);
  var packet = Buffer.concat([toBuffer([0x82]), remLen, payload]);
  this.client.write(packet);
};

MiniMQTT.prototype.subscribe = function(topic) {
  if (this.subscriptions.indexOf(topic) === -1) {
    this.subscriptions.push(topic);
  }
  this._sendSubscribe(topic);
};

MiniMQTT.prototype.publish = function(topic, message, retain) {
  if (!this.client || !this.connected) return;
  var firstByte = 0x30 | (retain ? 0x01 : 0x00);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var mBuf = toBuffer(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
  var remLen = encodeVarLength(tLen.length + tBuf.length + mBuf.length);
  var packet = Buffer.concat([toBuffer([firstByte]), remLen, tLen, tBuf, mBuf]);
  this.client.write(packet);
};

MiniMQTT.prototype.disconnect = function() {
  if (this.client && this.connected) {
    try {
      this.client.write(toBuffer([0xe0, 0x00])); // DISCONNECT
    } catch (e) {}
    this.connected = false;
    try {
      this.client.end();
    } catch (e) {}
  }
};

MiniMQTT.toBuffer = toBuffer;
MiniMQTT.zeroBuffer = zeroBuffer;
MiniMQTT.encodeVarLength = encodeVarLength;

module.exports = MiniMQTT;
