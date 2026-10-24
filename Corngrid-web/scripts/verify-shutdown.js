'use strict';
// Verifies the graceful shutdown path of server.js: a wrapper child process
// requires server.js, then emits SIGINT in-process (process.kill cannot
// deliver handleable signals to a Windows child), and this parent captures
// the output and exit code.
const { spawn } = require('child_process');
const path = require('path');

const wrapper = `
  process.env.PORT = '3202';
  require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
  setTimeout(() => process.emit('SIGINT'), 3000);
  setTimeout(() => { console.error('shutdown hung'); process.exit(9); }, 12000).unref();
`;

const child = spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

child.on('exit', (code, signalReceived) => {
  console.log('--- captured server output ---');
  console.log(out.trim());
  console.log('------------------------------');
  console.log(`exit code: ${code}, signal: ${signalReceived}`);
  const ok = code === 0 && out.includes('Received SIGINT') && out.includes('shutting down');
  console.log(ok ? 'GRACEFUL SHUTDOWN VERIFIED' : 'GRACEFUL SHUTDOWN NOT CONFIRMED');
  process.exit(ok ? 0 : 1);
});
