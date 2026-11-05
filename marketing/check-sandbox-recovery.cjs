const root = 'C:/Website/Website/Corngrid-web/';
require(root + 'node_modules/dotenv').config({ path: root + '.env', quiet: true });
const { Client } = require(root + 'node_modules/pg');
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const accounts = await client.query(`SELECT account_number,broker_server,last_heartbeat FROM mt5_accounts
      WHERE user_id IN (SELECT id FROM users WHERE username='Akram Jamil')`);
    console.log(JSON.stringify({ accounts: accounts.rows.map(row => ({
      ...row, heartbeatAgeSeconds: row.last_heartbeat ? Math.round((Date.now() - Number(row.last_heartbeat)) / 1000) : null
    })) }));
    const nodes = await client.query('SELECT name,status,running_instances,last_heartbeat_at FROM sandbox_nodes');
    console.log(JSON.stringify({ nodes: nodes.rows.map(row => ({ ...row,
      heartbeatAgeSeconds: Math.round((Date.now() - Number(row.last_heartbeat_at)) / 1000)
    })) }));
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
