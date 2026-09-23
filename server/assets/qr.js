/*
 * Minimal QR encoder: fixed version 4 (33x33), error correction L, byte mode.
 * One data block, so no interleaving. Enough for a dashboard URL and nothing
 * more, which is the whole point - a general encoder is many times this size.
 */

var QR_VER = 4, QR_SIZE = 33, QR_DATA_CW = 80, QR_EC_CW = 20;

// GF(256) log tables for the Reed-Solomon pass, built once.
var GF_EXP = [], GF_LOG = [];
(function () {
  var x = 1;
  for (var i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// The generator polynomial for QR_EC_CW check symbols.
function rsGenerator(n) {
  var g = [1];
  for (var i = 0; i < n; i++) {
    var ng = new Array(g.length + 1);
    for (var k = 0; k < ng.length; k++) ng[k] = 0;
    for (var j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = ng;
  }
  return g;
}

function rsEncode(data, n) {
  var gen = rsGenerator(n), rem = [], i;
  for (i = 0; i < n; i++) rem[i] = 0;
  for (i = 0; i < data.length; i++) {
    var factor = data[i] ^ rem[0];
    rem.shift();
    rem.push(0);
    for (var j = 0; j < n; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

/* Mode indicator 0100, then an 8-bit length, then the bytes, then the
   terminator and the alternating pad bytes the spec calls for. */
function buildData(str) {
  var bits = [], i, b;
  function push(val, len) {
    for (var k = len - 1; k >= 0; k--) bits.push((val >> k) & 1);
  }
  var bytes = [];
  for (i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else return null;          // ASCII only; a URL never needs more
  }
  if (bytes.length > QR_DATA_CW - 2) return null;
  push(4, 4);
  push(bytes.length, 8);
  for (i = 0; i < bytes.length; i++) push(bytes[i], 8);
  var cap = QR_DATA_CW * 8;
  for (i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  var cw = [];
  for (i = 0; i < bits.length; i += 8) {
    b = 0;
    for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    cw.push(b);
  }
  var pads = [0xEC, 0x11], p = 0;
  while (cw.length < QR_DATA_CW) cw.push(pads[p++ % 2]);
  return cw;
}

function blankMatrix() {
  var m = [], r, c;
  for (r = 0; r < QR_SIZE; r++) {
    m[r] = [];
    for (c = 0; c < QR_SIZE; c++) m[r][c] = null;   // null = still free
  }
  return m;
}

function placeFinder(m, r0, c0) {
  for (var r = -1; r <= 7; r++) {
    for (var c = -1; c <= 7; c++) {
      var rr = r0 + r, cc = c0 + c;
      if (rr < 0 || rr >= QR_SIZE || cc < 0 || cc >= QR_SIZE) continue;
      var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
               (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
               (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  }
}

function placeFunction(m) {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, QR_SIZE - 7);
  placeFinder(m, QR_SIZE - 7, 0);
  // Timing patterns.
  for (var i = 8; i < QR_SIZE - 8; i++) {
    m[6][i] = (i % 2 === 0) ? 1 : 0;
    m[i][6] = (i % 2 === 0) ? 1 : 0;
  }
  // Version 4 has a single alignment pattern, centred on (26, 26).
  for (var r = -2; r <= 2; r++) {
    for (var c = -2; c <= 2; c++) {
      var on = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
      m[26 + r][26 + c] = on ? 1 : 0;
    }
  }
  m[QR_SIZE - 8][8] = 1;   // the always-dark module
  // Reserve the format areas so data skips them.
  for (var k = 0; k <= 8; k++) {
    if (m[8][k] === null) m[8][k] = 0;
    if (m[k][8] === null) m[k][8] = 0;
  }
  for (var j = 0; j < 8; j++) {
    if (m[8][QR_SIZE - 1 - j] === null) m[8][QR_SIZE - 1 - j] = 0;
    if (m[QR_SIZE - 1 - j][8] === null) m[QR_SIZE - 1 - j][8] = 0;
  }
}

/* Data goes in two-module-wide columns, right to left, alternating direction
   and skipping the vertical timing column. */
function placeData(m, cw) {
  var bits = [], i, k;
  for (i = 0; i < cw.length; i++) {
    for (k = 7; k >= 0; k--) bits.push((cw[i] >> k) & 1);
  }
  var idx = 0, up = true;
  for (var col = QR_SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col--;                       // the timing column
    for (var n = 0; n < QR_SIZE; n++) {
      var row = up ? QR_SIZE - 1 - n : n;
      for (var s = 0; s < 2; s++) {
        var cc = col - s;
        if (m[row][cc] !== null) continue;
        m[row][cc] = (idx < bits.length) ? bits[idx] : 0;
        idx++;
      }
    }
    up = !up;
  }
}

function maskFn(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

// Which modules carry data, so masking and scoring leave the rest alone.
function functionMask() {
  var f = blankMatrix();
  placeFunction(f);
  var out = [], r, c;
  for (r = 0; r < QR_SIZE; r++) {
    out[r] = [];
    for (c = 0; c < QR_SIZE; c++) out[r][c] = (f[r][c] !== null);
  }
  return out;
}

var FORMAT_L = [
  // Pre-computed format bit strings for EC level L, masks 0-7.
  0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976
];

function placeFormat(m, mask) {
  var bitsVal = FORMAT_L[mask], i, b;
  for (i = 0; i <= 5; i++) {
    b = (bitsVal >> (14 - i)) & 1;
    m[8][i] = b;
  }
  m[8][7] = (bitsVal >> 8) & 1;
  m[8][8] = (bitsVal >> 7) & 1;
  m[7][8] = (bitsVal >> 6) & 1;
  for (i = 9; i <= 14; i++) {
    b = (bitsVal >> (14 - i)) & 1;
    m[14 - i][8] = b;
  }
  for (i = 0; i <= 7; i++) {
    b = (bitsVal >> (14 - i)) & 1;
    m[QR_SIZE - 1 - i][8] = b;
  }
  for (i = 8; i <= 14; i++) {
    b = (bitsVal >> (14 - i)) & 1;
    m[8][QR_SIZE - 15 + i] = b;
  }
}

function penalty(m) {
  var score = 0, r, c, i, run, dark = 0;
  // Rule 1: runs of five or more.
  for (r = 0; r < QR_SIZE; r++) {
    run = 1;
    for (c = 1; c < QR_SIZE; c++) {
      if (m[r][c] === m[r][c - 1]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (c = 0; c < QR_SIZE; c++) {
    run = 1;
    for (r = 1; r < QR_SIZE; r++) {
      if (m[r][c] === m[r - 1][c]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 2: 2x2 blocks of one colour.
  for (r = 0; r < QR_SIZE - 1; r++) {
    for (c = 0; c < QR_SIZE - 1; c++) {
      var v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: the finder-like 1:1:3:1:1 sequence, with four light either side.
  var p1 = [1,0,1,1,1,0,1,0,0,0,0], p2 = [0,0,0,0,1,0,1,1,1,0,1];
  function match(get, len) {
    var s = 0;
    for (var a = 0; a + 11 <= len; a++) {
      var ok1 = true, ok2 = true;
      for (var b2 = 0; b2 < 11; b2++) {
        var val = get(a + b2);
        if (val !== p1[b2]) ok1 = false;
        if (val !== p2[b2]) ok2 = false;
      }
      if (ok1) s += 40;
      if (ok2) s += 40;
    }
    return s;
  }
  for (r = 0; r < QR_SIZE; r++) {
    (function (rr) { score += match(function (i2) { return m[rr][i2]; }, QR_SIZE); })(r);
  }
  for (c = 0; c < QR_SIZE; c++) {
    (function (cc) { score += match(function (i2) { return m[i2][cc]; }, QR_SIZE); })(c);
  }
  // Rule 4: how far the dark share strays from half.
  for (r = 0; r < QR_SIZE; r++) for (c = 0; c < QR_SIZE; c++) if (m[r][c]) dark++;
  var pct = dark * 100 / (QR_SIZE * QR_SIZE);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function qrMatrix(text) {
  var cw = buildData(text);
  if (!cw) return null;
  var all = cw.concat(rsEncode(cw, QR_EC_CW));
  var isFn = functionMask();
  var best = null, bestScore = Infinity;
  for (var mask = 0; mask < 8; mask++) {
    var m = blankMatrix();
    placeFunction(m);
    placeData(m, all);
    for (var r = 0; r < QR_SIZE; r++) {
      for (var c = 0; c < QR_SIZE; c++) {
        if (!isFn[r][c] && maskFn(mask, r, c)) m[r][c] ^= 1;
      }
    }
    placeFormat(m, mask);
    var sc = penalty(m);
    if (sc < bestScore) { bestScore = sc; best = m; }
  }
  return best;
}

/*
 * Draws a code into an <svg>: a white tile with a two-module quiet zone and
 * the dark modules as one path. Returns false when the text will not fit.
 */
function qrDraw(svg, text) {
  var m = qrMatrix(text);
  if (!m) return false;
  var d = '';
  for (var y = 0; y < QR_SIZE; y++) {
    for (var x = 0; x < QR_SIZE; x++) {
      if (m[y][x]) d += 'M' + x + ' ' + y + 'h1v1h-1z';
    }
  }
  var s = QR_SIZE + 4;
  svg.setAttribute('viewBox', '-2 -2 ' + s + ' ' + s);
  svg.innerHTML = '<rect x="-2" y="-2" width="' + s + '" height="' + s + '" fill="#fff"/>' +
                  '<path d="' + d + '" fill="#000"/>';
  return true;
}
