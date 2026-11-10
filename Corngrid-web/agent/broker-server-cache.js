'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { lookup, brokerSearch } = require('./broker-resolution');

function cacheDir(server, config) {
  if (!config.brokerCacheDir) return null;
  const key = require('node:crypto').createHash('sha256').update(brokerSearch(server).toLowerCase()).digest('hex').slice(0, 24);
  return path.join(config.brokerCacheDir, key);
}

function copyBrokerServerCache(dir, server, config) {
  const sourceDir = lookup(config.brokerServerDataDirs, server) || cacheDir(server, config);
  if (!sourceDir) return false;
  const source = path.join(sourceDir, 'config', 'servers.dat');
  // A missing/stale cache must fall back to discovery, not prevent a new login.
  if (!fs.existsSync(source)) return false;
  const target = path.join(dir, 'config', 'servers.dat');
  if (path.resolve(source) === path.resolve(target)) return true;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !fs.existsSync(target + '.before-broker-repair')) {
    fs.copyFileSync(target, target + '.before-broker-repair');
  }
  // Only the broker directory is shared. Never import account databases or credentials.
  fs.copyFileSync(source, target);
  return true;
}

function saveBrokerServerCache(dir, server, config) {
  const targetDir = cacheDir(server, config);
  const source = path.join(dir, 'config', 'servers.dat');
  if (!targetDir || !fs.existsSync(source)) return false;
  fs.mkdirSync(path.join(targetDir, 'config'), { recursive: true });
  const target = path.join(targetDir, 'config', 'servers.dat');
  const temporary = target + '.' + require('node:crypto').randomUUID() + '.tmp';
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
  return true;
}
module.exports = { copyBrokerServerCache, saveBrokerServerCache };
