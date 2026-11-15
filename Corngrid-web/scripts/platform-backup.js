'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createBackup,verifyBackup}=require('../ops/backup');
async function main(){
 process.umask(0o077);const args=process.argv.slice(2),command=args.shift(),options={};
 if(!command||command==='--help'){console.log('node scripts/platform-backup.js create --source <Website root> --output <private .cgb file>\nnode scripts/platform-backup.js verify --input <private .cgb file> [--report <private JSON file>]\nUses BACKUP_ENCRYPTION_KEY. PostgreSQL verification requires RESTORE_CONTROL_DATABASE_URL on an isolated test cluster. Never restores into the live database.');return;}
 if(!['create','verify'].includes(command))throw Error('INVALID_COMMAND');while(args.length){const name=args.shift();if(!['--source','--output','--input','--report'].includes(name)||!args.length)throw Error('INVALID_OPTION');options[name.slice(2)]=args.shift();}
 if(options.report&&command!=='verify')throw Error('REPORT_REQUIRES_VERIFICATION');
 const key=process.env.BACKUP_ENCRYPTION_KEY;if(!key)throw Error('BACKUP_KEY_REQUIRED');let result;
 if(command==='create'){
  if(!options.source||!options.output)throw Error('SOURCE_AND_OUTPUT_REQUIRED');const root=path.resolve(options.source),file=path.join(root,'Corngrid-web/.env');const env={...(fs.existsSync(file)?require('dotenv').parse(fs.readFileSync(file)):{}),...process.env};
  result=await createBackup({sourceRoot:root,output:options.output,key,databaseUrl:env.DATABASE_URL,databasePath:env.DATABASE_PATH?path.resolve(root,'Corngrid-web',env.DATABASE_PATH):undefined,signingKeyDirectory:env.SANDBOX_NODE_UPDATE_DIR});
 }else{if(!options.input)throw Error('INPUT_REQUIRED');result=await verifyBackup({input:options.input,key,restoreControlUrl:process.env.RESTORE_CONTROL_DATABASE_URL});}
 if(options.report){if(command!=='verify')throw Error('REPORT_REQUIRES_VERIFICATION');fs.writeFileSync(options.report,JSON.stringify(result,null,2)+'\n',{mode:0o600});}
 console.log(JSON.stringify(result));
}
if(require.main===module)main().catch(error=>{console.error('Backup operation failed:',/^[A-Z_]+$/.test(error.code||error.message)?error.code||error.message:'BACKUP_OPERATION_FAILED');process.exitCode=1;});
module.exports={main};
