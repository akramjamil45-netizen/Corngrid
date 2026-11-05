'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const createSubscriptionApi = require('../subscriptions/subscription-api');

test('proof replacements, concurrency and rollback retain only the committed file', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-proof-regression-'));
  const previousProofDir = process.env.PAYMENT_PROOF_DIR;
  const previousDownloadDir = process.env.EA_DOWNLOAD_DIR;
  process.env.PAYMENT_PROOF_DIR = path.join(scratch, 'proofs');
  process.env.EA_DOWNLOAD_DIR = path.join(scratch, 'downloads');
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  try {
    const app = express();
    const subscriptions = createSubscriptionApi(app, db, (_req, _res, next) => next(), { verifyToken: (_req, _res, next) => next() }, () => {});
    await subscriptions.ready();
    await run(`INSERT INTO user_subscriptions (id,user_id,status,purchase_price,created_at,updated_at) VALUES (1,1,'pending_payment',1,1,1)`);
    await run(`INSERT INTO subscription_payments (id,user_id,subscription_id,amount,status,created_at,updated_at) VALUES (1,1,1,1,'pending_payment',1,1)`);
    const handlers = app.router.stack.find(layer => layer.route?.path === '/api/subscription/payment-proof').route.stack.map(layer => layer.handle);
    async function submit(body, userId = 1) {
      let status = 200; let data;
      const req = { user: { id: userId }, body, ip: '127.0.0.1' };
      const res = { status(value) { status = value; return this; }, set() { return this; }, json(value) { data = value; return this; } };
      for (const handler of handlers) {
        let continued = false;
        await handler(req, res, () => { continued = true; });
        if (!continued) break;
      }
      return { status, data };
    }
    const proof = text => ({ paymentId: 1, proofName: 'dummy.png', proofData: Buffer.from(text).toString('base64') });
    const files = () => fs.readdirSync(process.env.PAYMENT_PROOF_DIR);
    const current = async () => (await get('SELECT payment_proof_path FROM subscription_payments WHERE id=1')).payment_proof_path;
    assert.equal((await submit(proof('first'))).status, 200);
    const first = await current();
    assert.equal((await submit(proof('second'))).status, 200);
    assert.equal(fs.existsSync(path.join(process.env.PAYMENT_PROOF_DIR, first)), false);
    assert.deepEqual(files(), [await current()]);
    assert.deepEqual((await Promise.all([submit(proof('third')), submit(proof('fourth'))])).map(r => r.status), [200, 200]);
    assert.deepEqual(files(), [await current()]);
    const saved = await current();
    const originalRun = db.run;
    let failOnce = true;
    db.run = function(sql, params, callback) {
      if (failOnce && /UPDATE subscription_payments/.test(sql)) {
        failOnce = false;
        return callback(new Error('Dummy injected update failure'));
      }
      return originalRun.call(this, sql, params, callback);
    };
    assert.equal((await submit(proof('failed replacement'))).status, 500);
    db.run = originalRun;
    assert.deepEqual(files(), [saved]);
    assert.equal(await current(), saved);
    assert.equal((await submit({ paymentId: 1, paymentReference: 'DUMMY-REFERENCE' })).status, 200);
    assert.deepEqual(files(), [saved]);
    assert.equal((await submit(proof('wrong owner'), 2)).status, 404);
    await run("UPDATE subscription_payments SET status='approved' WHERE id=1");
    assert.equal((await submit(proof('already approved'))).status, 409);
    assert.deepEqual(files(), [saved]);
    for (let attempt = 0; attempt < 4; attempt++) await submit({ paymentId: 1, paymentReference: 'DUMMY' });
    assert.equal((await submit(proof('throttled'))).status, 429);
    assert.deepEqual(files(), [saved]);
  } finally {
    await new Promise(resolve => db.close(resolve));
    if (previousProofDir === undefined) delete process.env.PAYMENT_PROOF_DIR; else process.env.PAYMENT_PROOF_DIR = previousProofDir;
    if (previousDownloadDir === undefined) delete process.env.EA_DOWNLOAD_DIR; else process.env.EA_DOWNLOAD_DIR = previousDownloadDir;
    if (!path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Invalid scratch path');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
