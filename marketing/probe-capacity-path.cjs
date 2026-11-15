'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const modules = path.resolve(__dirname, '../Corngrid-web/node_modules');
const env = require(path.join(modules, 'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
const adminVersion = crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
const token = require(path.join(modules, 'jsonwebtoken')).sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'3m'});
async function main() {
  const listing = await fetch('http://127.0.0.1:3000/api/admin/sandbox/nodes', { headers: { Authorization: 'Bearer '+token }, signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const node = listing.nodes.find(n => n.id === 4);
  if (!node || node.usedSlots !== 0) throw Error('Expected idle VPS80481 node');
  const results = [];
  const routes = ['/api/health/ready', '/admin-sandbox.js', '/api/admin/sandbox/nodes', '/api/admin/sandbox/nodes/4/capacity'];
  for (const origin of ['http://127.0.0.1:8080', 'https://corngrid.com', 'https://corngrid.com', 'https://corngrid.com']) {
    await Promise.all(routes.map(async route => {
      const start=Date.now(), mutation=route.endsWith('/capacity');
      try {
        const r=await fetch(origin+route,{method:mutation?'PATCH':'GET',headers:{Cookie:'corngrid_session='+token,Origin:'https://corngrid.com',...(mutation?{'Content-Type':'application/json'}:{})},body:mutation?JSON.stringify({maxInstances:node.maxInstances,expectedMaxInstances:node.maxInstances}):undefined,signal:AbortSignal.timeout(4000)});
        await r.arrayBuffer();results.push({origin,route,status:r.status,ms:Date.now()-start});
      }catch(error){results.push({origin,route,error:error.code||error.name,ms:Date.now()-start});}
    }));
  }
  const report={at:new Date().toISOString(),requests:results.length,failures:results.filter(r=>r.status!==200).length,maxMs:Math.max(...results.map(r=>r.ms)),results};
  const label=process.argv[2]||'check';if(!/^[a-z-]{1,20}$/.test(label))throw Error('Invalid report label');
  fs.writeFileSync(path.join(__dirname,'capacity-path-'+label+'-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error('Capacity path verification failed:',e.code||e.name);process.exitCode=1;});
