'use strict';
// Observed facts only. A running terminal and an EA heartbeat do not establish
// a live broker connection or prove that an EA is placing trades.
function sandboxHealth({ instance, node, account, now = Date.now(), nodeTimeout = 90000, eaTimeout = 180000 }) {
  const fresh = (value, timeout) => Number(value) > 0 && Number(value) <= now + 60000 && now - Number(value) <= timeout;
  const hostOnline = !!node && node.status === 'active' && fresh(node.last_heartbeat_at, nodeTimeout);
  const terminalFresh = !!instance && fresh(instance.last_heartbeat_at, 120000);
  const eaFresh = !!account && fresh(account.last_heartbeat, eaTimeout);
  const authError = !!account && Number(account.auth_error_at) > Number(account.last_heartbeat || 0);
  const host = { status: !node ? 'unassigned' : hostOnline ? 'online' : 'offline', label: !node ? 'Not assigned' : hostOnline ? 'Online' : 'Offline', lastSeenAt: node?.last_heartbeat_at || null };
  const terminal = { status: !instance ? 'none' : instance.status === 'running' && (!hostOnline || !terminalFresh) ? 'stale' : instance.status,
    label: !instance ? 'Not set up' : instance.status === 'running' && (!hostOnline || !terminalFresh) ? 'Last reported running' : String(instance.status).replace(/^./, c => c.toUpperCase()), lastSeenAt: instance?.last_heartbeat_at || null };
  const mt5 = { status: authError ? 'authentication_error' : 'unverified', label: authError ? 'Authentication error' : 'Not verified',
    detail: authError ? 'Check the account login and broker server. A new verified heartbeat is required.' : 'Live broker connection is not independently reported. Check the connection in MT5.', lastSeenAt: null };
  const ea = { status: authError ? 'authentication_error' : eaFresh ? 'reporting' : account?.last_heartbeat ? 'offline' : 'waiting',
    label: authError ? 'Authentication error' : eaFresh ? 'Reporting' : account?.last_heartbeat ? 'Not reporting' : 'Waiting for first report',
    detail: instance?.trading_paused ? 'Trading is paused. Heartbeat reporting is separate from trade execution.' : 'A heartbeat confirms EA reporting; it does not prove that trades are being placed.', lastSeenAt: account?.last_heartbeat || null };
  let nextAction = null;
  if (instance && !hostOnline && node) nextAction = { title: 'Hosting node is offline', body: 'The node has stopped reporting. Contact support and check again before sending terminal controls.', page: 'chat', label: 'Contact support' };
  else if (instance?.status === 'failed') nextAction = { title: 'Sandbox needs attention', body: 'Review the last error and account configuration before retrying a start.', page: 'sandbox', label: 'Review details' };
  else if (authError || ea.status === 'offline') nextAction = { title: 'Check your EA connection', body: 'Review the broker login, terminal connection and EA settings. Your last received figures may be out of date.', page: 'monitoring', label: 'Open EA monitoring' };
  else if (instance && ['stopped', 'suspended'].includes(instance.status)) nextAction = { title: 'Sandbox is ' + instance.status, body: 'Review your subscription and the existing Sandbox controls when you are ready to continue.', page: instance.status === 'suspended' ? 'subscription' : 'sandbox', label: instance.status === 'suspended' ? 'Review subscription' : 'Review controls' };
  return { host, terminal, mt5, ea, nextAction, checkedAt: now };
}
module.exports = { sandboxHealth };
