const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite = require('sqlite3');
const { quotaSchema, respondDailyLimit } = require('../daily-limits');

test('daily quotas persist, include existing activity, resist deletion and serialize concurrent sends', async t => {
  const db = new sqlite.Database(':memory:');
  t.after(() => db.close());
  const exec = sql => new Promise((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
  const get = sql => new Promise((resolve, reject) => db.get(sql, (e,r) => e ? reject(e) : resolve(r)));
  await exec('CREATE TABLE posts(user_id INTEGER, created_at INTEGER); CREATE TABLE comments(user_id INTEGER, created_at INTEGER); CREATE TABLE dm(user_id INTEGER, created_at INTEGER); CREATE TABLE support(user_id INTEGER, created_at INTEGER, role TEXT);');
  const now = Date.now();
  const insert = (table, user = 1, extra = '') => exec(`INSERT INTO ${table} VALUES(${user}, ${now}${extra})`);
  await insert('posts');
  const post = quotaSchema('post', [{table:'posts',user:'user_id'}]);
  await exec(post + quotaSchema('comment', [{table:'comments',user:'user_id'}]) + quotaSchema('chat', [{table:'dm',user:'user_id'}, {table:'support',user:'user_id',condition:"role='user'",newCondition:"NEW.role='user'"}]));
  for (let i = 1; i < 25; i++) await insert('posts');
  await assert.rejects(insert('posts'), /DAILY_LIMIT_post/);
  await exec('DELETE FROM posts;');
  await exec(post); // Reinitializing must not lower the persistent count.
  await assert.rejects(insert('posts'), /DAILY_LIMIT_post/);
  await insert('posts', 2);
  await exec("UPDATE user_daily_usage SET day='2000-01-01' WHERE user_id=1 AND kind='post'");
  await insert('posts'); // A new day gets its own counter.
  await exec(`INSERT INTO user_daily_usage VALUES(1,'comment',date('now','+8 hours'),99)`);
  const attempts = await Promise.allSettled([insert('comments'), insert('comments')]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length, 1);
  assert.equal((await get('SELECT COUNT(*) AS n FROM comments')).n, 1);
  await exec(`INSERT INTO user_daily_usage VALUES(1,'chat',date('now','+8 hours'),499)`);
  await insert('support',1,",'user'");
  await assert.rejects(insert('dm'), /DAILY_LIMIT_chat/);
  await insert('support',1,",'admin'"); // Staff replies do not consume user quota.
  assert.equal((await get("SELECT used FROM user_daily_usage WHERE user_id=1 AND kind='chat'")).used,500);
});

test('quota response provides 429 and Malaysia midnight retry time', () => {
  const result = {};
  const res = { set(k,v){result[k]=v;},status(code){result.status=code;return this;},json(body){result.body=body;} };
  assert.equal(respondDailyLimit(new Error('SQLITE_CONSTRAINT: DAILY_LIMIT_chat'),res),true);
  assert.equal(result.status,429);
  assert.equal(result.body.limit,500);
  assert.ok(Number(result['Retry-After'])>0);
  assert.equal(new Date(result.body.resetAt+8*3600000).getUTCHours(),0);
  assert.equal(respondDailyLimit(new Error('other'),res),false);
});
