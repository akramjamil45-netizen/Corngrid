'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const registerEmailAdmin = require('../email-admin');

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => (error ? reject(error) : resolve()));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', error => (error ? reject(error) : resolve(db)));
  });
}

async function createHarness() {
  const db = await openDatabase();
  await exec(db, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      email_verified INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, email, email_verified, created_at) VALUES
      (1, 'Alice', 'alice@example.test', 1, 1760000000000),
      (2, 'Bob', 'bob@example.test', 1, 1760000001000);
  `);

  const messages = [];
  const transportConfigs = [];
  let failNext = false;
  const logger = { error() {}, warn() {}, info() {} };
  const createTransport = config => {
    transportConfigs.push(config);
    return {
      verify: async () => true,
      async sendMail(message) {
        if (failNext) {
          failNext = false;
          const error = new Error('550 mailbox unavailable');
          error.code = 'EENVELOPE';
          throw error;
        }
        messages.push(message);
        return {
          messageId: `<${messages.length}@corngrid.test>`,
          response: '250 2.0.0 OK'
        };
      }
    };
  };

  const app = express();
  app.use(express.json());
  const verifyAdminToken = (req, res, next) => {
    if (req.headers['x-test-admin'] === 'yes') return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };

  const emailAdmin = registerEmailAdmin(app, db, verifyAdminToken, {
    encryptionKey: 'test-email-encryption-key',
    logger,
    createTransport,
    autoStart: false,
    queueBatchSize: 50,
    queueIntervalMs: 1000,
    queueDelayMs: 0,
    maxAttempts: 2,
    appBaseUrl: 'https://corngrid.test',
    supportEmail: 'support@corngrid.test',
    envSettings: {
      host: 'smtp.corngrid.test',
      port: 587,
      username: 'mailer@corngrid.test',
      password: 'seed-secret',
      from: 'CornGrid <noreply@corngrid.test>',
      encryption: 'tls'
    }
  });
  await emailAdmin.ready();

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(method, pathname, body, { auth = true } = {}) {
    const headers = {};
    if (auth) headers['x-test-admin'] = 'yes';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function waitForQueue() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await get(db, "SELECT COUNT(*) AS total FROM email_queue WHERE status IN ('pending', 'sending')");
      if (Number(row && row.total) === 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('The email queue did not drain in time.');
  }

  async function close() {
    emailAdmin.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }

  return {
    db,
    messages,
    transportConfigs,
    request,
    waitForQueue,
    close,
    run: (sql, params) => run(db, sql, params),
    get: (sql, params) => get(db, sql, params),
    setFailNext(value) { failNext = value; }
  };
}

test('SMTP settings stay secret and require administrator authorization', async () => {
  const harness = await createHarness();
  try {
    const unauthorized = await harness.request('GET', '/api/admin/email/settings', undefined, { auth: false });
    assert.equal(unauthorized.response.status, 401);

    const initial = await harness.request('GET', '/api/admin/email/settings');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.data.settings.smtpHost, 'smtp.corngrid.test');
    assert.equal(initial.data.settings.passwordConfigured, true);
    assert.ok(!JSON.stringify(initial.data).includes('seed-secret'));
    assert.equal(initial.data.settings.password, undefined);

    const saved = await harness.request('PUT', '/api/admin/email/settings', {
      smtpHost: 'smtp.corngrid.test',
      smtpPort: 587,
      smtpUsername: 'mailer@corngrid.test',
      fromEmail: 'noreply@corngrid.test',
      fromName: 'CornGrid',
      encryption: 'tls',
      enabled: true,
      password: 'new-secret-password'
    });
    assert.equal(saved.response.status, 200);
    assert.ok(!JSON.stringify(saved.data).includes('new-secret-password'));
    assert.equal(saved.data.settings.passwordConfigured, true);

    const stored = await harness.get('SELECT smtp_password_enc, smtp_password_iv, smtp_password_tag FROM email_settings WHERE id = 1');
    assert.ok(stored.smtp_password_enc);
    assert.notEqual(stored.smtp_password_enc, 'new-secret-password');
    assert.ok(stored.smtp_password_iv);
    assert.ok(stored.smtp_password_tag);

    const injected = await harness.request('PUT', '/api/admin/email/settings', {
      smtpHost: 'smtp.corngrid.test',
      smtpPort: 587,
      smtpUsername: 'mailer@corngrid.test\r\nBcc: attacker@example.test',
      fromEmail: 'noreply@corngrid.test',
      fromName: 'CornGrid',
      encryption: 'tls',
      enabled: true
    });
    assert.equal(injected.response.status, 400);
  } finally {
    await harness.close();
  }
});

test('SMTP connection tests are authorized and rate limited', async () => {
  const harness = await createHarness();
  try {
    const unauthorized = await harness.request('POST', '/api/admin/email/settings/test', {}, { auth: false });
    assert.equal(unauthorized.response.status, 401);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tested = await harness.request('POST', '/api/admin/email/settings/test', {});
      assert.equal(tested.response.status, 200);
      assert.equal(tested.data.ok, true);
    }

    const limited = await harness.request('POST', '/api/admin/email/settings/test', {});
    assert.equal(limited.response.status, 429);
  } finally {
    await harness.close();
  }
});

test('direct sends log accepted_by_smtp and reject header injection', async () => {
  const harness = await createHarness();
  try {
    const injectedRecipient = await harness.request('POST', '/api/admin/email/send', {
      to: ['victim@example.test\nBcc: attacker@example.test'],
      subject: 'Hello',
      html: '<p>Hello</p>'
    });
    assert.equal(injectedRecipient.response.status, 400);

    const injectedSubject = await harness.request('POST', '/api/admin/email/send', {
      to: ['victim@example.test'],
      subject: 'Hello\r\nBcc: attacker@example.test',
      html: '<p>Hello</p>'
    });
    assert.equal(injectedSubject.response.status, 400);

    const sent = await harness.request('POST', '/api/admin/email/send', {
      to: ['alice@example.test'],
      cc: ['cc@example.test'],
      bcc: ['bcc@example.test'],
      subject: 'Account update',
      html: '<p>Hello Alice</p>',
      text: 'Hello Alice'
    });
    assert.equal(sent.response.status, 201);
    assert.equal(sent.data.status, 'sent');
    assert.equal(sent.data.deliveryStatus, 'accepted_by_smtp');

    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.messages[0].cc, ['cc@example.test']);
    assert.deepEqual(harness.messages[0].bcc, ['bcc@example.test']);
    assert.equal(harness.messages[0].subject, 'Account update');
    assert.equal(harness.transportConfigs.at(-1).auth.pass, 'seed-secret');

    const logs = await harness.request('GET', '/api/admin/email/logs?limit=10');
    assert.equal(logs.response.status, 200);
    assert.equal(logs.data.logs[0].status, 'sent');
    assert.equal(logs.data.logs[0].deliveryStatus, 'accepted_by_smtp');
    assert.equal(logs.data.logs[0].recipient, 'alice@example.test');

    const detail = await harness.request('GET', `/api/admin/email/logs/${sent.data.logId}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.data.email.status, 'sent');
    assert.ok(!JSON.stringify(detail.data).includes('seed-secret'));
    assert.ok(!JSON.stringify(detail.data).includes('smtp_password'));
  } finally {
    await harness.close();
  }
});

test('bulk announcements queue per recipient, personalize variables, and require confirmation', async () => {
  const harness = await createHarness();
  try {
    const noUsers = await harness.request('POST', '/api/admin/email/bulk', {
      subject: 'Hello',
      html: '<p>Hello</p>',
      userIds: []
    });
    assert.equal(noUsers.response.status, 400);

    const needsConfirmation = await harness.request('POST', '/api/admin/email/bulk', {
      subject: 'Hello',
      html: '<p>Hello</p>',
      allEligible: true
    });
    assert.equal(needsConfirmation.response.status, 400);
    assert.equal(needsConfirmation.data.requiresConfirmation, true);

    const queued = await harness.request('POST', '/api/admin/email/bulk', {
      subject: 'Hi {{username}}',
      html: '<p>Hi {{username}}</p>',
      text: 'Hi {{username}}',
      userIds: [1, 2]
    });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.data.queued, 2);
    assert.equal(queued.data.recipientCount, 2);

    await harness.waitForQueue();
    assert.equal(harness.messages.length, 2);
    assert.deepEqual(
      harness.messages.map(message => message.subject).sort(),
      ['Hi Alice', 'Hi Bob']
    );
    assert.deepEqual(
      harness.messages.map(message => message.to).sort(),
      ['alice@example.test', 'bob@example.test']
    );
    assert.ok(harness.messages.every(message => /Hi (Alice|Bob)/.test(message.html)));

    const queue = await harness.request('GET', '/api/admin/email/queue');
    assert.equal(queue.response.status, 200);
    assert.equal(queue.data.queue.pending, 0);
    assert.equal(queue.data.queue.sent, 2);

    const logs = await harness.request('GET', '/api/admin/email/logs?status=sent&limit=10');
    assert.equal(logs.data.pagination.total, 2);
    assert.ok(logs.data.logs.every(log => log.source === 'bulk'));
    assert.ok(logs.data.logs.every(log => log.attempts === 1));
  } finally {
    await harness.close();
  }
});

test('failed sends can be retried and history filters and paginates', async () => {
  const harness = await createHarness();
  try {
    harness.setFailNext(true);
    const failed = await harness.request('POST', '/api/admin/email/send', {
      to: ['bob@example.test'],
      subject: 'Will fail',
      html: '<p>Failure</p>'
    });
    assert.equal(failed.response.status, 502);
    assert.ok(failed.data.logId);

    const filtered = await harness.request('GET', '/api/admin/email/logs?status=failed&limit=1&page=1');
    assert.equal(filtered.response.status, 200);
    assert.equal(filtered.data.pagination.total, 1);
    assert.equal(filtered.data.logs[0].status, 'failed');
    assert.ok(filtered.data.logs[0].errorMessage);

    const retried = await harness.request('POST', `/api/admin/email/logs/${failed.data.logId}/retry`, {});
    assert.equal(retried.response.status, 200);
    assert.equal(retried.data.status, 'sent');
    assert.equal(retried.data.deliveryStatus, 'accepted_by_smtp');

    const detail = await harness.request('GET', `/api/admin/email/logs/${failed.data.logId}`);
    assert.equal(detail.data.email.status, 'sent');
    assert.equal(detail.data.email.deliveryStatus, 'accepted_by_smtp');
  } finally {
    await harness.close();
  }
});

test('templates are seeded and support CRUD plus variable previews', async () => {
  const harness = await createHarness();
  try {
    const initial = await harness.request('GET', '/api/admin/email/templates');
    assert.equal(initial.response.status, 200);
    assert.ok(initial.data.templates.length >= 8);
    assert.ok(initial.data.templates.every(template => template.isSystem === true));

    const created = await harness.request('POST', '/api/admin/email/templates', {
      name: 'Custom Notice',
      slug: 'custom_notice',
      description: 'Custom template',
      subject: 'Hello {{username}}',
      html: '<p>Hello {{username}}</p>',
      text: 'Hello {{username}}'
    });
    assert.equal(created.response.status, 201);
    assert.ok(created.data.id);

    const preview = await harness.request('POST', `/api/admin/email/templates/${created.data.id}/preview`, {
      variables: { username: 'Alice' }
    });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.data.subject, 'Hello Alice');
    assert.ok(preview.data.html.includes('Alice'));
    assert.ok(preview.data.text.includes('Alice'));

    const duplicate = await harness.request('POST', '/api/admin/email/templates', {
      name: 'Duplicate',
      slug: 'custom_notice',
      subject: 'Duplicate',
      html: '<p>Duplicate</p>',
      text: 'Duplicate'
    });
    assert.equal(duplicate.response.status, 409);

    const updated = await harness.request('PUT', `/api/admin/email/templates/${created.data.id}`, {
      name: 'Custom Notice Updated',
      slug: 'custom_notice',
      description: 'Updated',
      subject: 'Updated subject',
      html: '<p>Updated</p>',
      text: 'Updated'
    });
    assert.equal(updated.response.status, 200);

    const afterUpdate = await harness.request('GET', '/api/admin/email/templates');
    const template = afterUpdate.data.templates.find(item => item.id === created.data.id);
    assert.equal(template.name, 'Custom Notice Updated');
    assert.equal(template.subject, 'Updated subject');

    const deleted = await harness.request('DELETE', `/api/admin/email/templates/${created.data.id}`);
    assert.equal(deleted.response.status, 200);

    const afterDelete = await harness.request('GET', '/api/admin/email/templates');
    assert.ok(!afterDelete.data.templates.some(item => item.id === created.data.id));
  } finally {
    await harness.close();
  }
});

test('drafts can be created, loaded, updated, and deleted', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.request('POST', '/api/admin/email/drafts', {
      name: 'Draft',
      to: ['alice@example.test'],
      cc: ['cc@example.test'],
      bcc: [],
      subject: 'Draft subject',
      html: '<p>Draft</p>',
      text: 'Draft'
    });
    assert.equal(created.response.status, 201);
    assert.ok(created.data.id);

    const list = await harness.request('GET', '/api/admin/email/drafts');
    assert.equal(list.response.status, 200);
    const draft = list.data.drafts.find(item => item.id === created.data.id);
    assert.equal(draft.name, 'Draft');
    assert.deepEqual(draft.to, ['alice@example.test']);
    assert.deepEqual(draft.cc, ['cc@example.test']);

    const updated = await harness.request('PUT', `/api/admin/email/drafts/${created.data.id}`, {
      name: 'Draft updated',
      to: ['bob@example.test'],
      subject: 'Updated draft',
      html: '<p>Updated</p>',
      text: 'Updated'
    });
    assert.equal(updated.response.status, 200);

    const afterUpdate = await harness.request('GET', '/api/admin/email/drafts');
    const changed = afterUpdate.data.drafts.find(item => item.id === created.data.id);
    assert.equal(changed.name, 'Draft updated');
    assert.deepEqual(changed.to, ['bob@example.test']);

    const deleted = await harness.request('DELETE', `/api/admin/email/drafts/${created.data.id}`);
    assert.equal(deleted.response.status, 200);
    const afterDelete = await harness.request('GET', '/api/admin/email/drafts');
    assert.ok(!afterDelete.data.drafts.some(item => item.id === created.data.id));
  } finally {
    await harness.close();
  }
});

test('recipient selection only lists eligible registered users', async () => {
  const harness = await createHarness();
  try {
    const list = await harness.request('GET', '/api/admin/email/recipients?search=ali&limit=10');
    assert.equal(list.response.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.eligibleTotal, 2);
    assert.equal(list.data.users[0].email, 'alice@example.test');
    assert.equal(list.data.pagination.totalPages, 1);

    const page = await harness.request('GET', '/api/admin/email/recipients?page=2&limit=1');
    assert.equal(page.response.status, 200);
    assert.equal(page.data.users.length, 1);
    assert.equal(page.data.users[0].email, 'bob@example.test');
    assert.equal(page.data.pagination.totalPages, 2);
  } finally {
    await harness.close();
  }
});
