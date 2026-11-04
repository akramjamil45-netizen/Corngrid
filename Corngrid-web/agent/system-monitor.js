'use strict';

// Node-level resource sampling: CPU utilisation, memory, free disk.
// Per-process numbers come from PowerShell CIM (throttled by the caller).

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

let lastCpuSample = null;

// CPU utilisation computed from the delta between two os.cpus() samples.
function sampleCpuPercent() {
  const cpus = os.cpus();
  const totals = cpus.reduce((acc, cpu) => {
    acc.idle += cpu.times.idle;
    acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    return acc;
  }, { idle: 0, total: 0 });

  if (!lastCpuSample) {
    lastCpuSample = totals;
    return null; // first sample has no delta
  }
  const idleDelta = totals.idle - lastCpuSample.idle;
  const totalDelta = totals.total - lastCpuSample.total;
  lastCpuSample = totals;
  if (totalDelta <= 0) return null;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

function memoryMb() {
  return {
    totalMb: Math.round(os.totalmem() / 1048576),
    usedMb: Math.round((os.totalmem() - os.freemem()) / 1048576)
  };
}

function diskFreeMb(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    return Math.round((stats.bavail * stats.bsize) / 1048576);
  } catch (_error) {
    return null;
  }
}

// Working set (MB) for a set of PIDs via CIM. Returns a map pid -> MB.
// execFile with an argument array: no shell, no injection surface.
function processMemoryMb(pids) {
  return new Promise(resolve => {
    const unique = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
    if (!unique.length) return resolve(new Map());
    const filter = unique.map(pid => `ProcessId=${pid}`).join(' OR ');
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,WorkingSetSize | ConvertTo-Json`
    ], { timeout: 10000 }, (error, stdout) => {
      const map = new Map();
      if (error) return resolve(map);
      try {
        let parsed = JSON.parse(stdout);
        if (parsed && !Array.isArray(parsed)) parsed = [parsed];
        for (const row of parsed || []) {
          if (row && Number.isInteger(row.ProcessId)) {
            map.set(row.ProcessId, Math.round((row.WorkingSetSize || 0) / 1048576));
          }
        }
      } catch (_parseError) { /* leave map empty */ }
      resolve(map);
    });
  });
}

module.exports = { sampleCpuPercent, memoryMb, diskFreeMb, processMemoryMb };
