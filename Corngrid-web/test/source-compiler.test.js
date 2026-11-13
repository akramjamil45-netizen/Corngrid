'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createEaTester}=require('../agent/source-compiler');
const {isValidInstanceUid}=require('../agent/mt5-manager');
async function compile(t,{compiler=true,output=true,uploadFails=false,main='Expert Name.mq5',badManifest=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-compile-test-'));
  t.after(()=>{const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(dir));assert.match(relative,/^corngrid-compile-test-[a-z0-9]+$/i);fs.rmSync(path.resolve(dir),{recursive:true,force:true});});
  const base=path.join(dir,'mt5');fs.mkdirSync(base);if(compiler)fs.writeFileSync(path.join(base,'metaeditor64.exe'),'Test double; never executed');
  const ex5=Buffer.alloc(128,1);ex5.write('EX5',0,'ascii');
  const requests=[],calls=[];
  const transport={httpRequest:async(method,url,body)=>{requests.push({method,url,body});if(method==='GET')return {files:[{name:badManifest?'../escape.mq5':main,size:20}],publication:{entryFile:main}};if(Buffer.isBuffer(body)&&uploadFails)throw Error('Injected upload failure');return {ok:true};},downloadFile:async(_url,file)=>fs.writeFileSync(file,'void OnTick(){}')};
  const tester=createEaTester({config:{agentDataDir:dir,mt5BaseDir:base},logger:{info(){},error(){}},mt5:{isValidInstanceUid},transport,execFileImpl:(exe,args,options,done)=>{calls.push({exe,args,options});if(output)fs.writeFileSync(args[0].slice('/compile:'.length).replace(/\.mq5$/i,'.ex5'),ex5);done(null);}});
  const assignment={testInstanceUid:'eatest_aaaaaaaaaaaaaaaaaa',submissionId:1,reportId:2};
  const result=await tester.runTest(assignment);
  return {tester,requests,calls,result,ex5,dir,assignment,report:requests.find(r=>r.url.endsWith('/complete'))?.body};
}
test('test-node compilation uploads the exact EX5 before cleanup and reports compile-only validation',async t=>{
  const f=await compile(t);assert.equal(f.result.success,true);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].options.windowsHide,true);assert.equal(f.calls[0].options.timeout,180000);
  assert.ok(f.calls[0].args[0].endsWith('Expert Name.mq5'),'filename with spaces remains one execFile argument');
  assert.deepEqual(f.requests.find(r=>r.url.endsWith('/artifact')).body,f.ex5);
  assert.equal(f.report.kind,'compile');assert.equal(f.report.success,true);assert.match(f.report.runtimeLog,/not tested/);
  assert.equal(fs.existsSync(path.join(f.dir,'tests',f.assignment.testInstanceUid)),false);
});
test('missing compiler, missing output, ZIP-only projects and unsafe paths cannot report success',async t=>{
  for(const options of [{compiler:false},{output:false},{main:'Project.zip'},{badManifest:true}]){
    const f=await compile(t,options);assert.equal(f.result.success,false);assert.equal(f.report.success,false);assert.equal(f.requests.some(r=>r.url.endsWith('/artifact')),false);assert.ok(f.report.compileLog);
  }
  const f=await compile(t);await assert.rejects(f.tester.runTest({...f.assignment,testInstanceUid:'../outside'}),/Invalid/);
});
test('failed artifact transfer retries finitely and cannot become a successful compile report',async t=>{
  const f=await compile(t,{uploadFails:true});assert.equal(f.requests.filter(r=>r.url.endsWith('/artifact')).length,3);assert.equal(f.result.success,false);assert.equal(f.report.success,false);
});
