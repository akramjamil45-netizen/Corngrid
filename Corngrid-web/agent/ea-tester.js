'use strict';

// Isolated EA testing on a designated test node.
//
// Flow for a `test_ea` command:
//   1. download the submission's source files from the backend (node token)
//   2. compile with metaeditor64.exe (when present) and capture the log
//   3. deploy a throwaway isolated instance with a DEMO account
//   4. run it for a bounded period while sampling CPU/memory
//   5. post the report back and tear everything down
//
// Test instances use the eatest_ prefix and live in the same per-instance
// isolation model as real sandboxes, but on nodes flagged is_test_node that
// never host user trading.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TEST_RUN_MS = 3 * 60 * 1000; // how long the EA runs under observation
const COMPILE_TIMEOUT_MS = 3 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 5000;

function createEaTester({ config, logger, mt5, transport, systemMonitor }) {
  function testDir(testInstanceUid) {
    if (!mt5.isValidInstanceUid(testInstanceUid)) {
      throw new Error('Invalid test instance identifier.');
    }
    return path.join(config.agentDataDir, 'tests', testInstanceUid);
  }

  async function downloadSources(submissionId, files, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
      const name = path.basename(file.name);
      const target = path.join(targetDir, name);
      await transport.downloadFile(`/api/admin/ea-testing/${submissionId}/source/${encodeURIComponent(name)}`, target);
    }
  }

  function compile(sourceDir, mainFile) {
    return new Promise(resolve => {
      const metaeditor = path.join(config.mt5BaseDir, 'metaeditor64.exe');
      if (!fs.existsSync(metaeditor)) {
        return resolve({ attempted: false, log: 'metaeditor64.exe not present on this node; compilation skipped.' });
      }
      const logFile = path.join(sourceDir, 'compile.log');
      execFile(metaeditor, [`/compile:"${path.join(sourceDir, mainFile)}"`, `/log:"${logFile}"`],
        { timeout: COMPILE_TIMEOUT_MS }, error => {
          let log = '';
          try { log = fs.readFileSync(logFile, 'utf16le'); } catch { try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* no log */ } }
          resolve({ attempted: true, success: !error, log: log || (error ? error.message : 'compiled') });
        });
    });
  }

  async function runTest(payload) {
    const { testInstanceUid, submissionId, reportId, demoAccount } = payload || {};
    if (!mt5.isValidInstanceUid(testInstanceUid)) throw new Error('Invalid test instance identifier.');
    if (!Number.isInteger(reportId)) throw new Error('A report id is required.');
    if (!Number.isSafeInteger(Number(submissionId)) || Number(submissionId) < 1) {
      throw new Error('A submission id is required.');
    }

    const dir = testDir(testInstanceUid);
    const sourceDir = path.join(dir, 'source');
    let compileLog = '';
    let runtimeLog = '';
    let errorCount = 0;
    let cpuSamples = [];
    let memoryPeak = 0;
    let success = false;

    try {
      // 1. Fetch the source manifest, then the files.
      const manifest = await transport.httpRequest('GET', `/api/admin/ea-testing/${Number(submissionId)}/source`);
      const files = (manifest && manifest.files) || [];
      if (!files.length) throw new Error('No source files were returned for this submission.');
      await downloadSources(Number(submissionId), files, sourceDir);
      logger.info(testInstanceUid, `Downloaded ${files.length} source file(s) for testing.`);

      // 2. Compile the main .mq5 (or note the zip for manual review).
      const mainMq5 = files.map(f => f.name).find(name => name.toLowerCase().endsWith('.mq5'));
      if (mainMq5) {
        const compiled = await compile(sourceDir, mainMq5);
        compileLog = compiled.log || '';
        if (compiled.attempted && !compiled.success) {
          errorCount += 1;
          throw Object.assign(new Error('Compilation failed.'), { report: true });
        }
      } else {
        compileLog = 'Submission is a ZIP project; server-side review required before compilation.';
      }

      // 3. Deploy an isolated demo instance.
      if (!demoAccount || !demoAccount.accountNumber) {
        runtimeLog = 'No demo account configured (EA_TEST_* env vars); runtime stage skipped after compile.';
        success = true;
      } else {
        const deployResult = await mt5.deploy({
          instanceUid: testInstanceUid,
          brokerServer: demoAccount.brokerServer,
          accountNumber: demoAccount.accountNumber,
          password: demoAccount.password,
          installationSecret: '', // test EAs are unlicensed by design
          strategy: null, // source EA, not a published binary
          apiBaseUrl: config.backendUrl
        });

        // 4. Observe the running instance.
        const startedAt = Date.now();
        while (Date.now() - startedAt < TEST_RUN_MS) {
          await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));
          const pidMemory = await systemMonitor.processMemoryMb(mt5.trackedPids());
          for (const [, mb] of pidMemory) memoryPeak = Math.max(memoryPeak, mb);
          const cpu = systemMonitor.sampleCpuPercent();
          if (typeof cpu === 'number') cpuSamples.push(cpu);
          // A crash during testing is a failure signal.
          if (!mt5.statusReports().some(report => report.instanceUid === testInstanceUid)) {
            errorCount += 1;
            runtimeLog += 'Terminal process exited during the observation window.\n';
            break;
          }
        }
        success = errorCount === 0;
        await mt5.destroy({ instanceUid: testInstanceUid });
      }
    } catch (error) {
      if (!error.report) {
        runtimeLog += `Test harness error: ${error.message}\n`;
        errorCount += 1;
      }
      success = false;
      try { await mt5.destroy({ instanceUid: testInstanceUid }); } catch { /* already gone */ }
    } finally {
      // 5. Report back and clean up.
      const cpuAvg = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : null;
      try {
        await transport.httpRequest('POST', `/api/admin/ea-testing/reports/${reportId}/complete`, {
          success,
          compileLog: compileLog.slice(0, 18000),
          runtimeLog: runtimeLog.slice(0, 18000),
          cpuAvg,
          memoryPeakMb: memoryPeak || null,
          errorCount
        });
      } catch (error) {
        logger.error(testInstanceUid, `Failed to submit the test report: ${error.message}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }

    return { reportId, success };
  }

  return { runTest };
}

module.exports = { createEaTester };
