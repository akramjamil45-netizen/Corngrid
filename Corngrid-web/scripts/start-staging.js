'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const dotenv=require('dotenv');
function validateConfig(config,{root=path.resolve(__dirname,'..'),live={}}={}){
 if(!/^.{32,}$/.test(config.JWT_SECRET||'')||config.JWT_SECRET===live.JWT_SECRET)throw Error('Use a distinct staging JWT secret of at least 32 characters.');
 if(!/^[a-f0-9]{64}$/i.test(config.SANDBOX_ENCRYPTION_KEY||'')||config.SANDBOX_ENCRYPTION_KEY===live.SANDBOX_ENCRYPTION_KEY)throw Error('Use a distinct persistent staging encryption key.');
 if(!config.ADMIN_EMAIL||!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(config.ADMIN_PASSWORD_HASH||'')||config.ADMIN_PASSWORD_HASH===live.ADMIN_PASSWORD_HASH)throw Error('Configure a distinct staging administrator and password hash.');
 const port=Number(config.PORT||3100);if(!Number.isInteger(port)||port<1024||port>65535||port===3000)throw Error('Use a separate staging port (default 3100).');
 if(config.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY))throw Error('Staging accepts Stripe test keys only.');
 if(config.SMTP_HOST||config.SMTP_USER||config.SMTP_PASS)throw Error('Outbound SMTP is disabled in this staging launcher.');
 const normalized=raw=>{const u=new URL(raw);return u.hostname+':'+(u.port||'5432')+u.pathname;};
 if(config.DATABASE_URL){const url=new URL(config.DATABASE_URL);if(!['postgres:','postgresql:'].includes(url.protocol)||!/(?:_staging|_test)$/.test(url.pathname))throw Error('Use an explicitly named _staging or _test PostgreSQL database.');if(live.DATABASE_URL&&normalized(live.DATABASE_URL)===normalized(config.DATABASE_URL))throw Error('Staging cannot use the live database.');}
 else{if(!config.DATABASE_PATH||!/(?:staging|test).*\.sqlite$/i.test(path.basename(config.DATABASE_PATH)))throw Error('Use a dedicated staging/test SQLite file.');if(path.resolve(root,config.DATABASE_PATH)===path.resolve(root,live.DATABASE_PATH||'database.sqlite'))throw Error('Staging cannot use the live database.');}
 if(config.STAGING_DEMO_NODE_UID&&!/^node_[a-f0-9]{18}$/.test(config.STAGING_DEMO_NODE_UID))throw Error('Invalid staging demo node identity.');
 return {...config,PORT:String(port),HOST:'127.0.0.1',APP_BASE_URL:'http://127.0.0.1:'+port,NODE_ENV:'development',CORNGRID_STAGING:'true',DATABASE_URL:config.DATABASE_URL||'',DATABASE_PATH:config.DATABASE_PATH||'platform.staging.sqlite',MFA_ENCRYPTION_KEY:config.MFA_ENCRYPTION_KEY||config.SANDBOX_ENCRYPTION_KEY,EMAIL_ENCRYPTION_KEY:config.JWT_SECRET,STRIPE_SECRET_KEY:config.STRIPE_SECRET_KEY||'',STRIPE_WEBHOOK_SECRET:config.STRIPE_WEBHOOK_SECRET||'',STRIPE_PAYMENT_METHOD_CONFIGURATION:config.STRIPE_PAYMENT_METHOD_CONFIGURATION||'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',SMTP_PASSWORD:'',SMTP_FROM:'',SANDBOX_NODE_AUTO_UPDATE:'false',SANDBOX_NODE_UPDATE_DIR:'',STAGING_DEMO_NODE_UID:config.STAGING_DEMO_NODE_UID||'',BACKUP_INTERVAL_HOURS:'0'};
}
function main(){const args=process.argv.slice(2);if(args.includes('--help')){console.log('node scripts/start-staging.js --config <private .env.staging> [--check]\nRun only from a separate staging checkout. Binds loopback, rejects live Stripe keys/DB reuse, disables SMTP and agent publishing.');return;}
 const position=args.indexOf('--config');if(position<0||!args[position+1])throw Error('Supply --config with a private staging environment file.');const file=path.resolve(args[position+1]),root=path.resolve(__dirname,'..'),liveFile=path.join(root,'.env');if(file===liveFile)throw Error('The live environment file cannot be used for staging.');
 const config=dotenv.parse(fs.readFileSync(file)),live=fs.existsSync(liveFile)?dotenv.parse(fs.readFileSync(liveFile)):{};const values=validateConfig(config,{root,live});if(args.includes('--check')){console.log('Staging configuration passed. No server, database connection or external request was started.');return;}
 const env={...process.env,...Object.fromEntries(Object.keys(live).map(key=>[key,''])),...values,CORNGRID_ENV_FILE:file};
 if(args.includes('--migrate')){if(!values.DATABASE_URL){console.log('SQLite schema is applied at startup.');return;}execFileSync(process.execPath,[path.join(root,'scripts/apply-postgres-migrations.js')],{cwd:root,stdio:'inherit',env,windowsHide:true});return;}
 // One process avoids orphaning a backend when a Windows operator closes the
 // launcher. Authentication, workers and service shutdown stay in server.js.
 Object.assign(process.env,env);process.chdir(root);require('../server');
}
if(require.main===module){try{main();}catch(error){console.error(error.code==='MODULE_NOT_FOUND'?String(error.message).split('\n')[0]:'Staging configuration rejected. Use a separate test database, persistent test keys, test administrator and no SMTP/live Stripe keys.');process.exitCode=1;}}
module.exports={validateConfig};
