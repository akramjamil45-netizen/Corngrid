'use strict';
// Local commit preparation only. It never loads backend environment or credentials.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const named=new Set(['.gitignore','CornGrid-Node-Agent.zip','README.md','TUTORIAL SETUP NODE.MD','corngrid-ea.html','sw.js','web.config','web.config.xml',
 'marketing/README.md','marketing/SECOND_VPS_INSTALLATION.md','marketing/VPS80481-INSTALLATION.md','marketing/NODE_AUTO_UPDATE_DEPLOYMENT.md','marketing/CAPACITY_RELIABILITY_REPAIR.md',
 'marketing/publish-node-update.ps1','marketing/verify-node-bundle.cjs','marketing/install-loopback-gateway.ps1','marketing/inspect-node-capacity.cjs']);
const changed=git('diff','--name-only','--diff-filter=ACMRT','-z').split('\0').filter(Boolean);
const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean);
const files=[...new Set([...changed,...untracked])].filter(f=>f.startsWith('Corngrid-web/')||named.has(f)).sort();
const findings=[];
for(const file of files){
 if(/(?:^|\/)(?:\.env|agent-config\.json|signing-key\.pem|update-trust\.pem)$/.test(file)||/\.(?:sqlite|jks|keystore|rdp)$/.test(file))findings.push({file,rule:'private runtime file'});
 if(file.endsWith('.zip'))continue;
 const body=fs.readFileSync(path.join(root,file),'utf8');
 const patterns=[['Stripe key',/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],['webhook secret',/\bwhsec_[A-Za-z0-9]{20,}\b/g],['node credential',/\bcgn_[a-f0-9]{64}\b/g],['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],['AWS key',/\bAKIA[0-9A-Z]{16}\b/g]];
 for(const [rule,pattern] of patterns)for(const match of body.matchAll(pattern)){
  const value=match[0];
  if(file.includes('/test/')&&(/fixture|fake|notreal|for_test/.test(value)||rule==='node credential'&&new Set(value.slice(4)).size<5))continue;
  findings.push({file,rule});
 }
}
const result={candidateFiles:files.length,findings,excludedLocalFiles:untracked.filter(f=>!files.includes(f)).length};
fs.writeFileSync(path.join(__dirname,'project-commit-review-result.json'),JSON.stringify({...result,files},null,2));
console.log(JSON.stringify(result));
if(findings.length)process.exitCode=1;
else if(process.argv.includes('--stage')){git('add','--',...files);console.log('Reviewed project files staged.');}
