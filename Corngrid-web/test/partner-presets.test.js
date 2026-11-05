
const {test}=require('node:test');const assert=require('node:assert/strict');const {decodePresets}=require('../partner/presets');
const valid={symbol:'EURUSD',name:'ea.set',contentBase64:Buffer.from('TakeProfit=20\r\n').toString('base64')};
test('preset validation accepts UTF-16 and rejects duplicate pairs, paths, binary content and oversized files',()=>{
 assert.equal(decodePresets([valid])[0].text,'TakeProfit=20\r\n');
 assert.equal(decodePresets([{...valid,contentBase64:Buffer.from('\ufeffTakeProfit=30','utf16le').toString('base64')}])[0].text,'TakeProfit=30');
 for(const input of [[valid,valid],[{...valid,name:'../ea.set'}],[{...valid,symbol:'BTCUSD'}],[{...valid,contentBase64:'%%%'}],[{...valid,contentBase64:Buffer.from('#import "evil.dll"').toString('base64')}],[{...valid,contentBase64:Buffer.alloc(129*1024).toString('base64')}]])assert.throws(()=>decodePresets(input));
});
