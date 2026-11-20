const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCommandExecution } = require('../agent/command-execution');

test('WS/HTTPS redelivery reuses pending and completed deployment results', async () => {
  const execute = createCommandExecution();
  let calls = 0, finish;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = execute('cmd-1', 'deploy', operation);
  const duplicate = execute('cmd-1', 'deploy', operation);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ pid: 777 });
  assert.deepEqual(await first, await duplicate);
  assert.deepEqual(await execute('cmd-1', 'deploy', operation), { pid: 777 });
  assert.equal(calls, 1);
  await assert.rejects(execute('cmd-1', 'destroy', operation), /identity mismatch/);
});

test('failed command is acknowledged consistently and a fresh retry ID can execute', async () => {
  const execute = createCommandExecution();
  let calls = 0;
  const failure = () => { calls++; throw new Error('Broker refused'); };
  await assert.rejects(execute('cmd-1', 'deploy', failure), /Broker refused/);
  await assert.rejects(execute('cmd-1', 'deploy', failure), /Broker refused/);
  assert.equal(calls, 1);
  assert.equal(await execute('cmd-2', 'deploy', () => 'ok'), 'ok');
});

test('bounded command history never evicts an in-flight deployment', async () => {
  const execute = createCommandExecution(1);
  let finish;
  const first = execute('cmd-1', 'deploy', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await assert.rejects(execute('cmd-2', 'deploy', () => 'unexpected'), /queue is full/);
  finish('ok'); await first;
  assert.equal(await execute('cmd-2', 'deploy', () => 'new'), 'new');
  await assert.rejects(execute(undefined, 'deploy', () => 'invalid'), /Invalid command/);
});
