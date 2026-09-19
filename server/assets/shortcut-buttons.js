/*
 * Lists the shortcut buttons this TV's remote actually has, for shortcut-key.sh.
 *
 * Two inputs: the settings service's mapping_info, whose isActive flag marks the
 * buttons present on this model and remote, and a reason-to-key-constant table
 * read out of appLaunch.js. A button is only offered when it appears in both,
 * since without a key constant there is nothing to intercept.
 *
 * ES5 only: webOS 4 ships node 0.12.
 */

var fs = require('fs');

function read(path) {
  try { return fs.readFileSync(path, 'utf8'); } catch (e) { return ''; }
}

function main() {
  var mapRaw = read(process.argv[2]);
  var keysRaw = read(process.argv[3]);
  if (!mapRaw || !keysRaw) return '[]';

  var keys = {};
  keysRaw.split('\n').forEach(function (line) {
    var parts = line.split('\t');
    if (parts.length === 2 && parts[0] && parts[1]) keys[parts[0]] = parts[1];
  });

  var parsed;
  try { parsed = JSON.parse(mapRaw); } catch (e) { return '[]'; }
  var mapping = parsed && parsed.settings && parsed.settings.mapping_info;
  if (!mapping || !mapping.length) return '[]';

  var out = [];
  mapping.forEach(function (entry) {
    Object.keys(entry).forEach(function (name) {
      if (name === '_id') return;
      var info = entry[name];
      if (!info || info.isActive !== true) return;
      if (!keys[name]) return;      // no key constant, so not interceptable
      out.push({ button: name, key: keys[name], stockAppId: info.app_id || null });
    });
  });
  return JSON.stringify(out);
}

process.stdout.write(main());
