'use strict';
const PAIRS = ['XAUUSD','EURUSD','GBPUSD','USDJPY'];
function decodePresets(input) {
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>4)throw new Error('Upload at most one preset for each supported pair.');
 const seen=new Set();
 return input.map(file=>{
  if(!file||!PAIRS.includes(file.symbol)||seen.has(file.symbol))throw new Error('Preset pair must be unique: XAUUSD, EURUSD, GBPUSD or USDJPY.');
  seen.add(file.symbol);
  if(typeof file.name!=='string'||!/^[A-Za-z0-9._ -]{1,116}\.set$/i.test(file.name))throw new Error('Preset files must have a valid .set filename.');
  const base64=file.contentBase64;
  if(typeof base64!=='string'||base64.length>180000||!base64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new Error('Invalid preset file encoding or size.');
  const bytes=Buffer.from(base64,'base64');
  if(!bytes.length||bytes.length>128*1024)throw new Error('Each preset must be between 1 byte and 128 KB.');
  const text=bytes.toString(bytes[0]===0xff&&bytes[1]===0xfe?'utf16le':'utf8').replace(/^\ufeff/,'');
  if(text.includes('\0')||text.includes('\ufffd'))throw new Error('Preset must be UTF-8 or UTF-16LE text.');
  const lines=text.split(/\r?\n/).filter(line=>line.trim()&&!/^\s*;/.test(line));
  if(!lines.length||lines.some(line=>!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=[^\r\n]*$/.test(line)))throw new Error('Preset must contain MT5 input=value settings.');
  return {symbol:file.symbol,name:file.name,text};
 });
}
async function loadStrategyPreset(db,strategy,symbol) {
 if(strategy.code==='corngrid-ea'&&!strategy.submission_id)return {...require('../sandbox/sandbox-presets').loadPreset(symbol),kind:'corngrid'};
 if(!strategy.submission_id)return null;
 return new Promise((resolve,reject)=>db.get(`SELECT p.file_name AS name,p.content_text AS text FROM ea_submission_presets p JOIN ea_submissions s ON s.id=p.submission_id JOIN partner_profiles owner ON owner.user_id=s.partner_id WHERE p.submission_id=? AND p.symbol=? AND s.status='published' AND s.strategy_id=? AND owner.status='active'`,[strategy.submission_id,symbol,strategy.id],(e,row)=>e?reject(e):resolve(row?{...row,kind:'partner'}:null)));
}
module.exports={decodePresets,loadStrategyPreset,PAIRS};
