'use strict';
// Keep the running website's dependencies pinned to the tree tested in source.
// Only missing/version-mismatched package directories are replaced; old copies
// are moved to a bounded backup directory, never deleted.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../Corngrid-web/node_modules'),target=path.resolve('C:/Website/Website/Corngrid-web/node_modules');
function inventory(root){
 const found=new Map();
 function visit(dir){
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   if(!item.isDirectory()||item.name.startsWith('.'))continue;
   if(item.name.startsWith('@')){for(const child of fs.readdirSync(path.join(dir,item.name),{withFileTypes:true}))if(child.isDirectory())add(path.join(dir,item.name,child.name));}
   else add(path.join(dir,item.name));
  }
 }
 function add(dir){const file=path.join(dir,'package.json');if(!fs.existsSync(file))return;const pkg=JSON.parse(fs.readFileSync(file,'utf8'));found.set(path.relative(root,dir),pkg.version);const nested=path.join(dir,'node_modules');if(fs.existsSync(nested))visit(nested);}
 visit(root);return found;
}
function contained(base,file){const relative=path.relative(base,file);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Package path escaped intended directory');}
async function main(){
 const expected=inventory(source),actual=inventory(target),mismatches=[...expected].filter(([name,version])=>actual.get(name)!==version);
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({mismatches:mismatches.map(([name,expected])=>({name,expected,actual:actual.get(name)||null}))}));return;}
 const backup=path.join(os.tmpdir(),'CornGrid-marketplace-deps-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 for(const [name,version]of mismatches.sort(([a],[b])=>a.split(path.sep).length-b.split(path.sep).length)){
  const from=path.resolve(source,name),to=path.resolve(target,name),saved=path.resolve(backup,name);contained(source,from);contained(target,to);contained(backup,saved);
  if(fs.existsSync(path.join(to,'package.json'))&&JSON.parse(fs.readFileSync(path.join(to,'package.json'),'utf8')).version===version)continue;
  if(fs.existsSync(to)){fs.mkdirSync(path.dirname(saved),{recursive:true});fs.renameSync(to,saved);}
  fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:true,force:false});
 }
 const after=inventory(target);assert.ok([...expected].every(([name,version])=>after.get(name)===version),'Runtime package version mismatch');
 const sharp=require(path.join(target,'sharp'));const result=await sharp({create:{width:64,height:64,channels:3,background:'#ffd400'}}).webp().toBuffer();assert.ok(result.length>0);
 require(path.join(target,'sqlite3'));require(path.join(target,'pg'));require(path.join(target,'express'));require(path.join(target,'stripe'));
 console.log(JSON.stringify({synchronized:true,sourcePackageCount:expected.size,replaced:mismatches.length,backup,sharpNativeVerified:true,existingRuntimeModulesLoad:true}));
}
main().catch(error=>{console.error('Runtime dependency synchronization failed:',error.code||error.name);process.exitCode=1;});
