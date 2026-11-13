'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('watchdog recovers a disconnected tunnel after public timeout but leaves a healthy tunnel and transient failures alone', { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-watchdog-test-'));
  let ready = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/public') { req.socket.destroy(); return; }
    if (req.url === '/ready') { res.writeHead(ready ? 200 : 503); res.end(JSON.stringify({ readyConnections: ready ? 4 : 0 })); return; }
    if (req.url === '/gateway') { res.writeHead(503); res.end(JSON.stringify({status:'degraded'})); return; }
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const statePath = path.join(root, 'state.json');
  const wrapper = path.join(root, 'run.ps1');
  const script = path.resolve(__dirname, '../service/watchdog.ps1');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  // Stub Windows service access; no real service can be changed by this test.
  fs.writeFileSync(wrapper, `function Get-Service { param($Name) if($Name -eq 'CornGridGateway'){return $null}; @{Status='Running'} }\nfunction Restart-Service { throw 'No real services may be restarted' }\n& ${quote(script)} -StatePath ${quote(statePath)} -ProbeUrl '${origin}/origin' -PublicUrl '${origin}/public' -TunnelReadyUrl '${origin}/ready' -DryRun\n`);
  async function check(previous = {}) {
    fs.writeFileSync(statePath, JSON.stringify(previous));
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { windowsHide: true, stdio: 'ignore' });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('Watchdog test failed: ' + code)));
    });
    return JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  }
  try {
    const recovered = await check({ tunnelFailures: 2 });
    assert.equal(recovered.originHealthy, true); assert.equal(recovered.publicStatus, 0);
    assert.equal(recovered.tunnelReadyKnown, true); assert.equal(recovered.tunnelConnections, 0);
    assert.deepEqual(recovered.actions, ['would-recover-tunnel']);
    assert.equal((await check({})).actions.length, 0, 'one failed probe never restarts a service');
    const cooldown = await check({ tunnelFailures: 2, lastTunnelRecovery: Math.floor(Date.now()/1000) });
    assert.equal(cooldown.actions.length, 0, 'recovery cooldown prevents restart loops');
    ready = true;
    const healthy = await check({ tunnelFailures: 2 });
    assert.equal(healthy.tunnelConnections, 4); assert.equal(healthy.tunnelFailures, 0);
    assert.equal(healthy.actions.length, 0, 'a public probe failure alone cannot restart a healthy tunnel');
    fs.writeFileSync(wrapper, `function Get-Service { param($Name) @{Status='Running'} }\nfunction Restart-Service { throw 'No real services may be restarted' }\n& ${quote(script)} -StatePath ${quote(statePath)} -ProbeUrl '${origin}/origin' -PublicUrl '${origin}/public' -TunnelReadyUrl '${origin}/ready' -GatewayProbeUrl '${origin}/gateway' -DryRun\n`);
    const gatewayFailure=await check({gatewayFailures:2,tunnelFailures:2});
    assert.equal(gatewayFailure.gatewayHealthy,false);
    assert.deepEqual(gatewayFailure.actions,['would-recover-gateway'],'a failed gateway is recovered independently instead of restarting the healthy tunnel');
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.match(path.relative(os.tmpdir(), root), /^corngrid-watchdog-test-[a-z0-9]+$/i);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
