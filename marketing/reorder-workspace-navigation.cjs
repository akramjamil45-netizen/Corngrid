'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web/public');
const layouts={
 'dashboard.html':{attribute:'data-page',groups:[
  ['Community',['feed','chat']],
  ['Trading', ['overview','sandbox','monitoring','positions','history','market','economic']],
  ['Accounts & access',['accounts','subscription','downloads']],
  ['Strategies & partners',['marketplace','partner','partner-marketplace']]
 ]},
 'admin.html':{attribute:'data-admin-page',groups:[
  ['', ['overview','subscriptions','sandbox','account-requests']],
  ['Support & users',['support','reports','user-agreements']],
  ['EA & partners',['ea-submissions','marketplace','commissions']],
  ['Communications',['announcements','email','downloads']]
 ]}
};
for(const [name,layout] of Object.entries(layouts)){
 if(process.argv.includes('--user-only')&&name!=='dashboard.html')continue;
 const file=path.join(root,name),html=fs.readFileSync(file,'utf8');
 const nav=html.match(/<nav class="main-nav"[^>]*>[\s\S]*?<\/nav>/);assert.ok(nav,name);
 const items=[...nav[0].matchAll(/<(button|a)\b[\s\S]*?<\/\1>/g)].map(m=>m[0]);
 const byKey=new Map(items.map(item=>{const key=item.match(new RegExp(layout.attribute+'="([^"]+)"'));assert.ok(key,item);return [key[1],item];}));
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({file:name,items:[...byKey].map(([key,item])=>({key,label:item.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}))}));continue;}
 const keys=layout.groups.flatMap(g=>g[1]);assert.equal(new Set(keys).size,keys.length);
 assert.deepEqual([...byKey.keys()].sort(),[...keys].sort(),name+' menu membership changed; review before reordering');
 const opening=nav[0].slice(0,nav[0].indexOf('>')+1);
 const lines=[];for(const [label,pages] of layout.groups){
  if(label)lines.push('        <p class="nav-section-label">'+label.replace(/&/g,'&amp;')+'</p>');
  for(const key of pages)lines.push('        '+byKey.get(key));
 }
 fs.writeFileSync(file,html.replace(nav[0],opening+'\n'+lines.join('\n')+'\n      </nav>'));
 console.log(JSON.stringify({file:name,ordered:keys}));
}
