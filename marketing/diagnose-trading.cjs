const root = 'C:/Website/Website/Corngrid-web/';
require(root + 'node_modules/dotenv').config({ path: root + '.env', quiet: true });
const { Client } = require(root + 'node_modules/pg');
(async () => {
 const db = new Client({connectionString: process.env.DATABASE_URL});
 await db.connect();
 try {
  for (const [name, sql] of Object.entries({
   accounts: `SELECT a.id,a.account_number,a.broker_server,a.balance,a.equity,a.floating_profit,a.last_heartbeat,a.last_sync,(SELECT count(*) FROM mt5_positions p WHERE p.account_id=a.id) positions,(SELECT count(*) FROM mt5_deals t WHERE t.account_id=a.id) trades FROM mt5_accounts a JOIN users u ON u.id=a.user_id WHERE lower(u.username)='akram jamil'`,
   instances: `SELECT i.instance_uid,i.status,i.mt5_account_number,i.broker_server,i.process_id,i.last_error FROM sandbox_instances i JOIN users u ON u.id=i.user_id WHERE lower(u.username)='akram jamil'`
  })) {
   try { console.log(name, JSON.stringify((await db.query(sql)).rows)); }
   catch(e) { console.log(name,e.message); }
  }
 } finally {await db.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});

