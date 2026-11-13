'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function marketHarness(){
 const elements=new Map(),frames=new Map();let now=0,nextFrame=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',hidden:false,className:'',style:{},classList:{toggle(){},remove(){},contains(){return false;}},addEventListener(){}});return elements.get(id);};
 const document={getElementById:element,querySelectorAll:()=>[],addEventListener(){},body:{classList:{remove(){},contains(){return false;}}}};
 const window={matchMedia:()=>({matches:false}),addEventListener(){}};
 const context=vm.createContext({window,document,Intl,Map,Date,Number,String,Boolean,Math,URL,AbortController,AbortSignal,
  performance:{now:()=>now},requestAnimationFrame(fn){const id=++nextFrame;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},
  setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:()=>new Promise(()=>{})});
 let source=fs.readFileSync(path.join(__dirname,'../public/market.js'),'utf8');
 source=source.replace('  window.CornGridMarket = {','  window.priceTest = { state, animateNumber, applySummary, selectSymbol };\n  window.CornGridMarket = {');
 vm.runInContext(source,context);
 const advance=milliseconds=>{now+=milliseconds;const pending=[...frames.entries()];frames.clear();for(const [,fn]of pending)fn(now);};
 return {api:window.priceTest,element,advance,frames};
}

test('changing from an EA gold quote to Twelve Data forex cannot restore the old animated price',()=>{
 const {api,element,advance,frames}=marketHarness();
 api.applySummary({symbol:'XAUUSD',source:{kind:'corngrid-ea',feed:'preview'},digits:2,bid:4015.70,ask:4015.90,state:'LIVE',dayOpen:4000,previousClose:3990});
 advance(100);assert.ok(Number(element('market-price').textContent.replace(/,/g,''))>1);
 api.selectSymbol('EURUSD');
 api.applySummary({symbol:'EURUSD',provider:'Twelve Data',source:{kind:'fallback',label:'Twelve Data'},price:1.10863,dayOpen:1.10001,dayHigh:1.11002,dayLow:1.09003,previousClose:1.10000});
 advance(700);advance(700);
 assert.equal(element('market-price').textContent,'1.10863');
 assert.equal(element('info-open').textContent,'1.10001');
 assert.equal(element('info-prev-close').textContent,'1.10000');
 assert.equal(frames.size,0);
});

test('new prices replace older animations while preserving currency precision',()=>{
 const {api,element,advance}=marketHarness();const price=element('price');
 api.animateNumber(price,0,4015.70,{format:'#,##0.00'});advance(100);
 api.animateNumber(price,0,1.10000,{format:'#,##0.00000'});advance(700);advance(700);
 assert.equal(price.textContent,'1.10000');
 api.animateNumber(price,0,4015.70,{format:'#,##0.00'});advance(700);
 assert.equal(price.textContent,'4,015.70');
});
