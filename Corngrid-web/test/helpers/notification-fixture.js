'use strict';
const sqlite = require('sqlite3').verbose(), express = require('express'), jwt = require('jsonwebtoken');
const fs = require('node:fs'), path = require('node:path');
const { dbRun, dbGet, dbAll } = require('../../db-async');
const { createNotificationCenter, registerNotificationRoutes } = require('../../notification-center');
async function createFixture() {
  const db = new sqlite.Database(':memory:'); let stamp = Date.now();
  await new Promise((resolve, reject) => db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,email_verified INTEGER DEFAULT 1);
    CREATE TABLE user_auth_versions(user_id INTEGER PRIMARY KEY,version INTEGER);
    CREATE TABLE sandbox_nodes(id INTEGER PRIMARY KEY,status TEXT,last_heartbeat_at BIGINT);
    CREATE TABLE sandbox_instances(id INTEGER PRIMARY KEY,user_id INTEGER,node_id INTEGER,status TEXT,last_heartbeat_at BIGINT,started_at BIGINT,updated_at BIGINT,deleted_at BIGINT);
    CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY,user_id INTEGER,account_number TEXT,last_heartbeat BIGINT,linked_at BIGINT,auth_error_at BIGINT);
    CREATE TABLE user_subscriptions(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,starts_at BIGINT,expires_at BIGINT,deleted_at BIGINT);
    CREATE TABLE subscription_payments(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,amount REAL,currency TEXT,payment_method TEXT,updated_at BIGINT);
    CREATE TABLE stripe_orders(id TEXT PRIMARY KEY,payment_id INTEGER,user_id INTEGER,activated_at BIGINT);
    INSERT INTO users VALUES(1,'Fixture one','one@example.test','fixture-password',1),(2,'Fixture two','two@example.test','fixture-password',1);
    ${fs.readFileSync(path.join(__dirname, '../../migrations/sqlite/0010_account_archives.sql'), 'utf8')}
  `, error => error ? reject(error) : resolve()));
  const service = createNotificationCenter({ db, now: () => stamp }); await service.ready();
  const app = express(), secret = 'notification-fixture-jwt-private-test'; app.use(express.json());
  const verifyToken = require('../../user-auth')({ db, jwtSecret: secret });
  registerNotificationRoutes(app, db, verifyToken, service);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { db, app, service, base, time: () => stamp, setTime: value => { stamp = value; },
    run: (sql, params) => dbRun(db, sql, params), get: (sql, params) => dbGet(db, sql, params), all: (sql, params) => dbAll(db, sql, params),
    token: id => jwt.sign({ id, authVersion: 0 }, secret, { expiresIn: '5m' }),
    async close() { await service.stop(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); }
  };
}
module.exports = { createFixture };
