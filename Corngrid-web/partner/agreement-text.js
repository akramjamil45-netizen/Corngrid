'use strict';
const crypto=require('node:crypto');
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');

function agreementText(row){
 if(sha256(row.receipt_json)!==row.receipt_hash)throw Error('Agreement receipt integrity check failed');
 const receipt=JSON.parse(row.receipt_json),terms=receipt.terms;
 if(!terms||!Array.isArray(terms.sections)||!['en','ms'].includes(receipt.language)||
    sha256(JSON.stringify(terms))!==receipt.termsHash||receipt.termsHash!==row.terms_hash||
    receipt.agreementId!==row.id||receipt.termsVersion!==row.terms_version)throw Error('Agreement snapshot integrity check failed');
 const value=input=>input===null||input===undefined||input===''?'-':String(input).replace(/[\r\n\x00-\x08\x0b-\x1f\x7f]+/g,' ');
 const lines=[
  'CORNGRID - PARTNER PROGRAMME AGREEMENT',
  'DIGITAL ACCEPTANCE RECORD',
  '='.repeat(64),
  `Agreement ID: ${value(receipt.agreementId)}`,
  `Operator: ${value(receipt.operator)}`,
  `User ID: ${value(receipt.userId)}`,
  `Account username: ${value(receipt.accountUsername)}`,
  `Account email: ${value(receipt.accountEmail)}`,
  `Signer name: ${value(receipt.signerName)}`,
  `Partner display name: ${value(receipt.applicationDisplayName)}`,
  `Company: ${value(receipt.company)}`,
  `Website: ${value(receipt.website)}`,
  `Terms version: ${value(receipt.termsVersion)}`,
  `Selected language: ${receipt.language==='ms'?'Bahasa Melayu (BM)':'English (EN)'}`,
  `Accepted at (UTC): ${value(receipt.acceptedAtUTC)}`,
  `Terms accepted: ${receipt.accepted===true?'Yes':'No'}`,
  `Authority confirmed: ${receipt.authorityConfirmed===true?'Yes':'No'}`,
  `Acceptance method: ${value(receipt.acceptanceMethod)}`,
  `Recorded IP address: ${value(receipt.ipAddress)}`,
  `Recorded user agent: ${value(receipt.userAgent)}`,
  '', 'SAVED TERMS SNAPSHOT',
  `Effective date: ${value(terms.effectiveDate)}`,
  `Contact: ${value(terms.contact)}`,
  'The following text is the saved version accepted at registration.',
  'The selected language appears first; the other saved language follows.'
 ];
 for(const lang of [receipt.language,receipt.language==='en'?'ms':'en']){
  if(typeof terms.title?.[lang]!=='string')throw Error('Saved agreement translation unavailable');
  lines.push('', '='.repeat(64),lang==='ms'?'BAHASA MELAYU':'ENGLISH',terms.title[lang],'='.repeat(64));
  terms.sections.forEach((section,index)=>{
   if(typeof section.title?.[lang]!=='string'||typeof section.text?.[lang]!=='string')throw Error('Saved agreement section unavailable');
   lines.push('',`${index+1}. ${section.title[lang]}`,section.text[lang]);
  });
 }
 lines.push('', '='.repeat(64),'SOURCE RECORD INTEGRITY',
  `Terms SHA-256: ${row.terms_hash}`,`Original JSON receipt SHA-256: ${row.receipt_hash}`,
  'This is a readable export of the stored acceptance record.',
  'The hashes identify the saved terms and original JSON, not this TXT file.',
  'The original acceptance record and terms have not been changed.','');
 return lines.join('\r\n');
}
module.exports={agreementText};
