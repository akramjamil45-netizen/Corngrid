'use strict';

const LIMITS = { post: 25, comment: 100, chat: 500 };
const daySql = "date(created_at / 1000, 'unixepoch', '+8 hours')";
const currentDay = "date('now', '+8 hours')";
function quotaSchema(kind, sources) {
  const total = sources.map(s => `SELECT ${s.user} AS user_id, ${daySql} AS day FROM ${s.table} WHERE ${s.condition || '1'}`).join(' UNION ALL ');
  return `
    CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id INTEGER NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, kind, day)
    );
    INSERT INTO user_daily_usage(user_id, kind, day, used)
      SELECT user_id, '${kind}', day, COUNT(*) FROM (${total}) WHERE day = ${currentDay}
      GROUP BY user_id, day
      ON CONFLICT(user_id, kind, day) DO UPDATE SET used = MAX(used, excluded.used);
    ${sources.map(s => `
      CREATE TRIGGER IF NOT EXISTS daily_limit_${s.table}_before BEFORE INSERT ON ${s.table}
      WHEN ${s.newCondition || '1'} BEGIN
        SELECT CASE WHEN COALESCE((SELECT used FROM user_daily_usage
          WHERE user_id = NEW.${s.user} AND kind = '${kind}' AND day = ${currentDay}), 0) >= ${LIMITS[kind]}
          THEN RAISE(ABORT, 'DAILY_LIMIT_${kind}') END;
      END;
      CREATE TRIGGER IF NOT EXISTS daily_limit_${s.table}_after AFTER INSERT ON ${s.table}
      WHEN ${s.newCondition || '1'} BEGIN
        INSERT INTO user_daily_usage(user_id, kind, day, used) VALUES(NEW.${s.user}, '${kind}', ${currentDay}, 1)
        ON CONFLICT(user_id, kind, day) DO UPDATE SET used = used + 1;
      END;
    `).join('\n')}
  `;
}
function respondDailyLimit(error, res) {
  const kind = /DAILY_LIMIT_(post|comment|chat)\b/.exec(error.message || '')?.[1];
  if (!kind) return false;
  const now = Date.now(), day = 86400000, offset = 8 * 3600000;
  const resetAt = (Math.floor((now + offset) / day) + 1) * day - offset;
  res.set('Retry-After', String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
  res.status(429).json({ code: 'DAILY_LIMIT_REACHED', kind, limit: LIMITS[kind], resetAt,
    error: `Daily limit reached: ${LIMITS[kind]} ${kind === 'chat' ? 'chat messages' : kind + 's'} per day. Resets at midnight Malaysia time (UTC+8).` });
  return true;
}
module.exports = { LIMITS, quotaSchema, respondDailyLimit };
