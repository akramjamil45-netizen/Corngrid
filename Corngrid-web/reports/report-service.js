'use strict';
const { dbAll, dbGet, isPostgres } = require('../db-async');
const { normalizeMt5Currency, mt5CurrencySql } = require('../mt5-currency');
const DAY = 86400000;
const TYPES = { admin: ['growth', 'sandbox', 'funds', 'performance', 'subscription', 'milestone', 'blank'], user: ['account', 'sandbox', 'partner'] };
const TITLES = { growth: 'Platform Growth', sandbox: 'Sandbox & Infrastructure', funds: 'Total Account Funds', performance: 'Client Performance', subscription: 'Subscription Snapshot', milestone: 'Milestone Announcement', blank: 'Blank CornGrid Template', account: 'Account performance', partner: 'Partner Report' };
const DESCRIPTIONS = {
  growth: 'Editorial growth headline, registration chart and six platform KPIs.',
  sandbox: 'Current sandbox status cards with fresh-heartbeat visibility.',
  funds: 'Balance and equity highlights with a currency-safe comparison.',
  performance: 'Net P/L spotlight, received-deal chart and trading statistics.',
  subscription: 'Active subscriptions, expiry indicators and activation activity.',
  milestone: 'One verified platform highlight with three supporting statistics.',
  blank: 'Write your own content inside the official CornGrid header and footer.'
};
const MILESTONES = { 'registered-users': 0, 'new-registrations': 1, 'linked-accounts': 2, 'active-subscribers': 4, sandboxes: 5 };
function invalid(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function dateKey(stamp, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(stamp)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function midnight(key, timezone) {
  const target = Date.parse(key + 'T00:00:00Z');
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const adjustment = target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += adjustment;
    if (!adjustment) break;
  }
  return guess;
}
function addDays(key, count) { return new Date(Date.parse(key + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10); }
function reportWindow(query, now) {
  const timezone = query.timezone || 'Asia/Kuala_Lumpur';
  if (typeof timezone !== 'string' || timezone.length > 80) invalid('Choose a valid timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { invalid('Choose a valid timezone.'); }
  const period = query.period || 'weekly';
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(period)) invalid('Choose daily, weekly, monthly or yearly.');
  const today = dateKey(now, timezone), anchor = query.date || today;
  if (typeof anchor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !Number.isFinite(Date.parse(anchor + 'T00:00:00Z')) || new Date(anchor + 'T00:00:00Z').toISOString().slice(0, 10) !== anchor || anchor < '2000-01-01' || anchor > today) invalid('Choose a valid reporting date, no later than today.');
  let start = anchor, end = anchor;
  if (period === 'weekly') {
    const weekday = new Date(anchor + 'T12:00:00Z').getUTCDay();
    start = addDays(anchor, -((weekday + 6) % 7)); end = addDays(start, 6);
  } else if (period === 'monthly') {
    start = anchor.slice(0, 7) + '-01';
    const d = new Date(anchor + 'T12:00:00Z');
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
  } else if (period === 'yearly') { start = anchor.slice(0, 4) + '-01-01'; end = anchor.slice(0, 4) + '-12-31'; }
  // A selected calendar period is always bounded by the extraction cutoff.
  const startMs = midnight(start, timezone), endMs = midnight(addDays(end, 1), timezone);
  const until = Math.min(now + 1, endMs), current = endMs > now;
  const buckets = [];
  if (period === 'daily') {
    for (let at = startMs; at < until; at += 3600000) buckets.push({ start: at, end: Math.min(at + 3600000, until), label: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' }).format(at) });
  } else if (period === 'yearly') {
    for (let month = 1; month <= 12; month++) {
      const key = `${start.slice(0, 4)}-${String(month).padStart(2, '0')}-01`, at = midnight(key, timezone);
      if (at >= until) break;
      const next = month === 12 ? `${+start.slice(0, 4) + 1}-01-01` : `${start.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-01`;
      buckets.push({ start: at, end: Math.min(midnight(next, timezone), until), label: new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short' }).format(at) });
    }
  } else {
    for (let key = start; midnight(key, timezone) < until; key = addDays(key, 1)) buckets.push({ start: midnight(key, timezone), end: Math.min(midnight(addDays(key, 1), timezone), until), label: key.slice(5) });
  }
  return { timezone, period, start, end: dateKey(until - 1, timezone), startMs, until, current, buckets };
}
function id(value, label) {
  if (value == null || value === '' || value === 'all') return null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(`Invalid ${label}.`);
  return Number(value);
}
const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const metric = (label, value, unit = 'count', currency = null) => ({ label, value: numeric(value), unit, currency });
const notArchived = alias => `NOT EXISTS (SELECT 1 FROM account_archives ar WHERE ar.user_id = ${alias}.user_id)`;
function accountScope(role, userId, accountId, currency) {
  const parts = [notArchived('a')], params = [];
  if (role === 'user') { parts.push('a.user_id = ?'); params.push(userId); }
  if (accountId) { parts.push('a.id = ?'); params.push(accountId); }
  if (currency) { parts.push(`${mt5CurrencySql('a.currency')} = ?`); params.push(currency); }
  return { sql: parts.join(' AND '), params };
}
// Buckets are computed in the selected timezone; SQL only aggregates received rows.
async function series(db, { from, condition, params, timestamp, value, window, count = false }) {
  if (!window.buckets.length) return [];
  const cases = window.buckets.map((_, index) => `WHEN ${timestamp} < ? THEN ${index}`).join(' ');
  const rows = await dbAll(db, `SELECT CASE ${cases} ELSE -1 END AS bucket, COUNT(*) AS received, ${count ? 'COUNT(*)' : `SUM(${value})`} AS value${count ? '' : `, SUM(CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END) AS missing`} FROM ${from} WHERE ${condition} AND ${timestamp} >= ? AND ${timestamp} < ? GROUP BY bucket`, [...window.buckets.map(b => b.end), ...params, window.startMs, window.until]);
  const byBucket = new Map(rows.map(row => [Number(row.bucket), row]));
  return window.buckets.map((bucket, index) => {
    const row = byBucket.get(index);
    return { label: bucket.label, value: row ? (Number(row.missing) > 0 ? null : numeric(row.value)) : count ? 0 : null };
  });
}
function createReportService(db, { now = Date.now, heartbeatSeconds = 180 } = {}) {
  const fresh = stamp => stamp != null && Number(stamp) >= now() - heartbeatSeconds * 1000 && Number(stamp) <= now() + 60000;
  async function activePartner(userId) {
    return Boolean(await dbGet(db, `SELECT p.user_id FROM partner_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND p.status = 'active' AND ${notArchived('p')}`, [userId]));
  }
  async function partnerCurrencies(userId) {
    const rows = await dbAll(db, 'SELECT currency FROM partner_transactions WHERE partner_id = ? UNION SELECT currency FROM partner_payouts WHERE partner_id = ? ORDER BY currency', [userId, userId]);
    // MYR is the partner ledger schema default, independent of MT5 currencies.
    return rows.length ? rows.map(row => row.currency) : ['MYR'];
  }
  async function options(role, userId) {
    const scope = accountScope(role, userId);
    const [accounts, currencies] = await Promise.all([
      dbAll(db, `SELECT a.id, a.account_name, a.account_number, ${mt5CurrencySql('a.currency')} AS currency FROM mt5_accounts a WHERE ${scope.sql} ORDER BY a.id DESC LIMIT 500`, scope.params),
      dbAll(db, `SELECT DISTINCT ${mt5CurrencySql('a.currency')} AS currency FROM mt5_accounts a WHERE ${scope.sql} ORDER BY currency`, scope.params)
    ]);
    const partner = role === 'user' && await activePartner(userId);
    return { types: TYPES[role].filter(value => value !== 'partner' || partner).map(value => ({ value, label: role === 'admin' ? TITLES[value] : value === 'sandbox' ? 'Sandbox status' : TITLES[value], ...(role === 'admin' ? { description: DESCRIPTIONS[value] } : {}) })), currencies: currencies.map(a => a.currency), partnerCurrencies: partner ? await partnerCurrencies(userId) : [], accounts: accounts.map(a => ({ id: a.id, label: `${a.account_name || 'MT5'} · …${String(a.account_number).slice(-4)} · ${a.currency}`, currency: a.currency })), accountLimit: 500 };
  }
  async function generate(role, userId, query) {
    // Users cannot inject another owner or an administrator report type.
    if (Object.hasOwn(query, 'userId') || Object.hasOwn(query, 'partnerId') || Object.hasOwn(query, 'role')) invalid('Report ownership is set by your signed-in session.');
    const type = query.type || TYPES[role][0];
    if (!TYPES[role].includes(type)) invalid('This report type is not available for your account.', 403);
    const stamp = now(), window = reportWindow(query, stamp), accountId = id(query.accountId, 'account ID');
    if (type === 'blank') return {
      version: 1, mode: 'manual', scope: 'admin', type, title: TITLES.blank,
      period: { kind: window.period, start: window.start, end: window.end, partial: false }, timezone: window.timezone,
      generatedAt: new Date(stamp).toISOString(), sourceAsOf: null, currency: null, selectedAccountId: null,
      metrics: [], chart: null, content: { title: '', subtitle: '', highlight: '', body: '', byline: '' },
      notes: ['Admin-authored content. No platform statistics are inserted or independently verified.'],
      source: 'Admin-authored content', privacy: 'Only the content you enter appears in this template.'
    };
    if (type === 'milestone' && query.milestoneMetric !== undefined && (typeof query.milestoneMetric !== 'string' || !Object.hasOwn(MILESTONES, query.milestoneMetric))) invalid('Choose a supported milestone metric.');
    if (query.currency != null && (typeof query.currency !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(query.currency))) invalid('Choose a valid account currency.');
    let currency = query.currency || null;
    if (type === 'partner') {
      if (!await activePartner(userId)) invalid('An active partner account is required for this report.', 403);
      if (accountId) invalid('Partner reports use your partner ledger, not an MT5 account.');
      const currencies = await partnerCurrencies(userId);
      if (currency && !currencies.includes(currency)) invalid('Currency is not available in your partner ledger.');
      if (!currency && currencies.length === 1) currency = currencies[0];
      const condition = `t.partner_id = ?${currency ? ' AND t.currency = ?' : ''}`, params = currency ? [userId, currency] : [userId];
      const totals = await dbGet(db, `SELECT
        COALESCE(SUM(CASE WHEN t.status IN ('approved','paid') THEN t.commission_amount ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN t.status = 'pending' THEN t.commission_amount ELSE 0 END), 0) AS pending,
        COUNT(*) AS records FROM partner_transactions t WHERE ${condition} AND t.status IN ('pending','approved','paid') AND t.created_at >= ? AND t.created_at < ?`, [...params, window.startMs, window.until]);
      const payouts = await dbGet(db, `SELECT COALESCE(SUM(amount), 0) AS paid FROM partner_payouts WHERE partner_id = ?${currency ? ' AND currency = ?' : ''} AND status = 'paid' AND paid_at >= ? AND paid_at < ?`, [...params, window.startMs, window.until]);
      const strategies = await dbGet(db, `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published FROM ea_submissions WHERE partner_id = ? AND deleted_at IS NULL`, [userId]);
      const money = value => currency ? Math.round(Number(value) * 100) / 100 : null;
      const points = currency ? (await series(db, { from: 'partner_transactions t', condition: condition + " AND t.status IN ('approved','paid')", params, timestamp: 't.created_at', value: 't.commission_amount', window })).map(point => ({ ...point, value: money(point.value ?? 0) })) : window.buckets.map(bucket => ({ label: bucket.label, value: null }));
      return {
        version: 1, mode: 'production', scope: 'user', type, title: TITLES.partner,
        period: { kind: window.period, start: window.start, end: window.end, partial: window.current }, timezone: window.timezone,
        generatedAt: new Date(stamp).toISOString(), sourceAsOf: null, currency, selectedAccountId: null,
        metrics: [metric('Approved commissions · period', money(totals.approved), 'currency', currency), metric('Pending commissions · period', money(totals.pending), 'currency', currency), metric('Paid payouts · period', money(payouts.paid), 'currency', currency), metric('Commission records · period', totals.records), metric('Published strategies · now', strategies.published), metric('Total strategies · now', strategies.total)],
        chart: { title: 'Approved commissions · creation date', unit: 'currency', currency, points },
        notes: [
          'Only your partner ledger and non-deleted strategy submissions are included. Strategy counts are current snapshots.',
          'Commissions are grouped by creation date using their current status. Approved includes paid commissions; pending is not paid income. Rejected and cancelled records are excluded.',
          'Paid payouts use the actual paid date. They may settle commissions created in an earlier period; approved commissions and payouts must not be added together.',
          ...(currency ? [`All monetary values are in ${currency}; no currency conversion is applied.`] : ['Multiple ledger currencies are present. Choose one currency to view monetary values; totals are N/A until selected.'])
        ], source: 'CornGrid partner transactions, paid payouts and strategy submissions',
        privacy: 'Partner identity, customer details, payout references and bank details are omitted from shared reports.'
      };
    }
    if (currency) {
      currency = normalizeMt5Currency(currency);
      if (!currency) invalid('Choose a valid MT5 account currency.');
    }
    const baseScope = accountScope(role, userId, accountId);
    const accounts = await dbAll(db, `SELECT a.id, ${mt5CurrencySql('a.currency')} AS currency FROM mt5_accounts a WHERE ${baseScope.sql}`, baseScope.params);
    if (accountId && !accounts.length) invalid('MT5 account not found.', 404);
    const currencies = [...new Set(accounts.map(a => a.currency))];
    if (currency && !currencies.includes(currency)) invalid('Currency is not available in the selected account scope.');
    if (!currency && currencies.length === 1) currency = currencies[0];
    const scope = accountScope(role, userId, accountId, currency);
    const notes = [], metrics = [];
    let chart = null, sourceAsOf = null;
    const add = (...args) => metrics.push(metric(...args));
    if (type === 'growth' || type === 'milestone') {
      const epoch = isPostgres(db) ? 'EXTRACT(EPOCH FROM u.created_at) * 1000' : "CAST(strftime('%s', u.created_at) AS INTEGER) * 1000";
      const activeUsers = 'NOT EXISTS (SELECT 1 FROM account_archives ar WHERE ar.user_id = u.id)';
      const totals = await dbGet(db, `SELECT COUNT(*) AS total, SUM(CASE WHEN ${epoch} >= ? AND ${epoch} < ? THEN 1 ELSE 0 END) AS added FROM users u WHERE ${activeUsers}`, [window.startMs, window.until]);
      const mt5 = await dbGet(db, `SELECT COUNT(*) AS total, SUM(CASE WHEN a.last_heartbeat >= ? AND a.last_heartbeat <= ? THEN 1 ELSE 0 END) AS online FROM mt5_accounts a WHERE ${notArchived('a')}`, [stamp - heartbeatSeconds * 1000, stamp + 60000]);
      add('Registered users · now', totals.total); add('New registrations · period', totals.added || 0); add('Linked MT5 accounts · now', mt5.total); add('Online MT5 accounts · now', mt5.online || 0);
      const subs = await dbGet(db, `SELECT COUNT(DISTINCT user_id) AS total FROM user_subscriptions s WHERE status = 'active' AND deleted_at IS NULL AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?) AND ${notArchived('s')}`, [stamp, stamp]);
      add('Active subscribers · now', subs.total);
      const boxes = await dbGet(db, `SELECT COUNT(*) AS total FROM sandbox_instances s WHERE deleted_at IS NULL AND ${notArchived('s')}`);
      add('Sandboxes · now', boxes.total);
      chart = { title: 'New registrations', unit: 'count', points: await series(db, { from: 'users u', condition: activeUsers, params: [], timestamp: epoch, window, count: true }) };
      notes.push('Registration counts exclude archived profiles. Current KPI totals are measured at generation; the chart covers the selected period.');
    } else if (type === 'subscription') {
      const rows = await dbGet(db, `SELECT
        COUNT(DISTINCT CASE WHEN status = 'active' AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?) THEN user_id END) AS subscribers,
        SUM(CASE WHEN status = 'active' AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'expired' OR (status = 'active' AND expires_at <= ?) THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN status = 'active' AND starts_at <= ? AND expires_at > ? AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring,
        SUM(CASE WHEN starts_at >= ? AND starts_at < ? THEN 1 ELSE 0 END) AS activated,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
        FROM user_subscriptions s WHERE deleted_at IS NULL AND ${notArchived('s')}`,
      [stamp, stamp, stamp, stamp, stamp, stamp, stamp, stamp + 7 * DAY, window.startMs, window.until]);
      add('Active subscribers · now', rows.subscribers); add('Active subscriptions · now', rows.active || 0);
      add('Expired subscriptions · now', rows.expired || 0); add('Expiring within 7 days', rows.expiring || 0);
      add('Activations · period', rows.activated || 0); add('Suspended subscriptions', rows.suspended || 0);
      chart = { title: 'Subscription activations', unit: 'count', points: await series(db, { from: 'user_subscriptions s', condition: `s.deleted_at IS NULL AND ${notArchived('s')}`, params: [], timestamp: 's.starts_at', window, count: true }) };
      notes.push('Subscriber and status totals are current snapshots; the chart counts recorded subscription starts in the selected period. Deleted subscriptions and archived users are excluded.');
      notes.push('Active subscriptions are not proof of payment. Revenue, renewals and growth percentages are not inferred. Expiry indicators use the next 7 days from generation.');
    } else if (type === 'sandbox') {
      const where = ['s.deleted_at IS NULL', notArchived('s')], params = [];
      if (role === 'user') { where.push('s.user_id = ?'); params.push(userId); }
      const rows = await dbAll(db, `SELECT s.status, s.last_heartbeat_at, s.cpu_percent, s.memory_mb FROM sandbox_instances s WHERE ${where.join(' AND ')}`, params);
      const online = rows.filter(s => s.status === 'running' && fresh(s.last_heartbeat_at));
      add('Total sandboxes · now', rows.length); add('Running with fresh heartbeat', online.length);
      add('Stopped / stopping / suspended', rows.filter(s => ['stopped', 'stopping', 'suspended'].includes(s.status)).length);
      add('Failed', rows.filter(s => s.status === 'failed').length);
      add('Starting / queued', rows.filter(s => ['requested', 'allocating', 'deploying', 'starting'].includes(s.status)).length);
      add('Running with stale heartbeat', rows.filter(s => s.status === 'running' && !fresh(s.last_heartbeat_at)).length);
      const asOfs = rows.map(s => Number(s.last_heartbeat_at)).filter(v => v > 0 && v <= stamp + 60000);
      sourceAsOf = asOfs.length ? new Date(Math.min(...asOfs)).toISOString() : null;
      chart = { title: 'Sandboxes created in period', unit: 'count', points: await series(db, { from: 'sandbox_instances s', condition: where.join(' AND '), params, timestamp: 's.created_at', window, count: true }) };
      notes.push('Statuses are a current snapshot, not historical uptime. Deleted sandboxes are excluded. Fresh heartbeat threshold: ' + heartbeatSeconds + ' seconds.');
    } else {
      if (currencies.length > 1 && !currency) notes.push('Select one currency to view monetary totals. No currency conversion or mixed-currency summation is performed.');
      // Most recent observation in the selected window; no manufactured opening balance.
      const observed = await dbAll(db, `SELECT a.id, a.currency, a.balance, a.equity, a.floating_profit, a.last_heartbeat, a.last_sync,
        s.balance AS historical_balance, s.equity AS historical_equity, s.floating_profit AS historical_floating, s.captured_at
        FROM mt5_accounts a LEFT JOIN mt5_snapshots s ON s.id = (SELECT x.id FROM mt5_snapshots x WHERE x.account_id = a.id AND x.captured_at >= ? AND x.captured_at < ? ORDER BY x.captured_at DESC LIMIT 1)
        WHERE ${scope.sql}`, [window.startMs, window.until, ...scope.params]);
      const usable = observed.map(a => {
        const current = window.current && numeric(a.last_heartbeat) !== null && Number(a.last_heartbeat) <= stamp + 60000;
        return { balance: current ? numeric(a.balance) : numeric(a.historical_balance), equity: current ? numeric(a.equity) : numeric(a.historical_equity), floating: current ? numeric(a.floating_profit) : numeric(a.historical_floating), at: current ? numeric(a.last_heartbeat) : numeric(a.captured_at) };
      });
      const total = key => currency && usable.length && usable.every(a => a[key] !== null) ? usable.reduce((sum, a) => sum + a[key], 0) : null;
      const deals = await dbGet(db, `SELECT COUNT(*) AS total, SUM(d.profit + d.commission + d.swap) AS net, SUM(CASE WHEN d.commission IS NULL OR d.swap IS NULL THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN d.profit + d.commission + d.swap > 0 THEN 1 ELSE 0 END) AS wins FROM mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id WHERE ${scope.sql} AND d.closed_at >= ? AND d.closed_at < ?`, [...scope.params, window.startMs, window.until]);
      const complete = Number(deals.total) > 0 && Number(deals.missing) === 0;
      if (type === 'funds') {
        add('Observed account balance', total('balance'), 'currency', currency); add('Observed account equity', total('equity'), 'currency', currency);
        add('Observed floating P/L', total('floating'), 'currency', currency); add('Linked accounts in scope', observed.length);
        add('Accounts with balance data', usable.filter(a => a.balance !== null).length);
        add('Net closed P/L · period', currency && complete ? deals.net : null, 'currency', currency);
      } else {
        add('Net closed P/L · period', currency && complete ? deals.net : null, 'currency', currency);
        add('Received closed deals', deals.total); add('Win rate · received deals', complete ? Number(deals.wins) / Number(deals.total) * 100 : null, 'percent');
        add('Observed account balance', total('balance'), 'currency', currency); add('Observed account equity', total('equity'), 'currency', currency); add('Linked accounts in scope', observed.length);
      }
      const times = usable.map(a => a.at).filter(a => a !== null);
      sourceAsOf = times.length ? new Date(Math.min(...times)).toISOString() : null;
      chart = type === 'funds'
        ? { title: 'Balance and equity comparison', kind: 'comparison', unit: 'currency', currency, points: [{ label: 'Balance', value: total('balance') }, { label: 'Equity', value: total('equity') }] }
        : { title: 'Net closed P/L · received deals', unit: 'currency', currency, points: currency ? await series(db, { from: 'mt5_deals d JOIN mt5_accounts a ON a.id = d.account_id', condition: scope.sql, params: scope.params, timestamp: 'd.closed_at', value: 'd.profit + d.commission + d.swap', window }) : window.buckets.map(b => ({ label: b.label, value: null })) };
      notes.push('Net P/L includes received profit, commission and swap. Missing costs or no received deals produce N/A. Deal history may be incomplete.');
      notes.push(window.current ? 'Balances are latest received MT5 observations; they are not deposits, platform revenue or guaranteed live prices.' : 'Balances use the last received snapshot inside the selected period. Missing or retained-out history produces N/A.');
      if (window.current && usable.some(a => !fresh(a.at))) notes.push('One or more accounts have stale or missing heartbeats. Refreshing cannot replace missing EA data.');
      if (usable.some(a => a.balance === null)) notes.push('Balance/equity totals require a complete observation for every account in the selected scope.');
    }
    return { version: 1, mode: 'production', scope: role, type, title: role === 'user' && type === 'sandbox' ? 'Sandbox status' : TITLES[type], ...(type === 'milestone' ? { milestone: { metricId: query.milestoneMetric || 'registered-users', metricIndex: MILESTONES[query.milestoneMetric || 'registered-users'] } } : {}), period: { kind: window.period, start: window.start, end: window.end, partial: window.current }, timezone: window.timezone, generatedAt: new Date(stamp).toISOString(), sourceAsOf, currency, selectedAccountId: accountId, metrics, chart, notes, source: 'CornGrid database · received MT5 / platform records', privacy: 'Account identifiers, customer names and credentials are omitted from shared images.' };
  }
  return { options, generate };
}
module.exports = { createReportService, reportWindow, dateKey, midnight };
