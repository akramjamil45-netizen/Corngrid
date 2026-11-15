const root='C:/Website/Website/Corngrid-web/';
require(root+'node_modules/dotenv').config({path:root+'.env',quiet:true});
const {Client}=require(root+'node_modules/pg');
(async()=>{const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();try{
const nodes=(await db.query('SELECT name,agent_version,status,last_heartbeat_at FROM sandbox_nodes WHERE status=$1',['active'])).rows;
const instances=(await db.query(`SELECT u.username,i.status,i.process_id,i.last_error,i.trading_paused,a.ea_name,a.last_heartbeat,a.balance,a.equity FROM sandbox_instances i JOIN users u ON u.id=i.user_id LEFT JOIN mt5_accounts a ON a.user_id=i.user_id AND a.account_number=i.mt5_account_number AND lower(a.broker_server)=lower(i.broker_server) WHERE i.deleted_at IS NULL AND i.status='running'`)).rows;
console.log(JSON.stringify({now:new Date().toISOString(),nodes:nodes.map(n=>({...n,heartbeatAgeSeconds:Math.round((Date.now()-Number(n.last_heartbeat_at))/1000)})),instances:instances.map(i=>({...i,heartbeatAgeSeconds:Math.round((Date.now()-Number(i.last_heartbeat))/1000)}))}));
}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
