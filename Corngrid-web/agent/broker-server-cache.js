'use strict';
const fs = require('node:fs');
const path = require('node:path');

function copyBrokerServerCache(dir, server, config) {
  const sourceDir = config.brokerServerDataDirs?.[server];
  if (!sourceDir) return false;
  const source = path.join(sourceDir, 'config', 'servers.dat');
  if (!fs.existsSync(source)) throw new Error(`Broker server cache is unavailable for ${server}.`);
  const target = path.join(dir, 'config', 'servers.dat');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !fs.existsSync(target + '.before-broker-repair')) {
    fs.copyFileSync(target, target + '.before-broker-repair');
  }
  // Only the broker directory is shared. Never import account databases or credentials.
  fs.copyFileSync(source, target);
  return true;
}
module.exports = { copyBrokerServerCache };