'use strict';
// Stage only this feature. Existing unrelated operator files stay untouched.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),git=args=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const names=git(['diff','--name-only']).trim().split(/\r?\n/).filter(Boolean),allowed=new Set(['.gitignore','CornGrid-Node-Agent.zip','CornGrid-Node-Agent-Linux.tar.gz','CornGrid-Node-Agent-Linux.tar.gz.sha256','Corngrid-web/README.md','Corngrid-web/package.json','web.config','web.config.xml']);
const newFiles=git(['ls-files','--others','--exclude-standard','Corngrid-web/agent','Corngrid-web/proxy','Corngrid-web/sandbox','Corngrid-web/migrations','Corngrid-web/docs','Corngrid-web/scripts','Corngrid-web/test']).trim().split(/\r?\n/).filter(Boolean);
const operators=['deploy-proxy-server.cjs','restart-proxy-website.ps1','prepare-proxy-acceptance.cjs','proxy-acceptance-server.cjs','proxy-source-ip.cjs','proxy-vps-audit.ps1','proxy-vps-install.ps1','test-proxy-vps.cjs','prepare-proxy-commit.cjs'].map(name=>'marketing/'+name);
for(const name of names)assert(allowed.has(name)||operators.includes(name)||/^Corngrid-web\/(agent|public|sandbox|scripts|test)\//.test(name),'Unexpected tracked change '+name);
const files=[...new Set([...names,...newFiles,...operators])];
for(const name of files){assert(!name.includes('.proxy-install-private'));if(/\.(cjs|js|ps1|json|md|sql|html|css)$/.test(name)){const text=fs.readFileSync(path.join(root,name),'utf8');assert(!/cgpx_[a-f0-9]{64}(?![a-f0-9])|cgn_[a-f0-9]{64}(?![a-f0-9])|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),'Credential material in '+name);}}
git(['add','--',...files]);git(['add','-f','--','CornGrid-Proxy-Server.zip']);git(['diff','--cached','--check']);
console.log(JSON.stringify({staged:files.length+1,privateFilesExcluded:true,unrelatedUntrackedFilesPreserved:true}));
