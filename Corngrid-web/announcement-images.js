'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const MAX_BYTES=5*1024*1024;
const FORMATS={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
function createAnnouncementImageUpload(uploadDir,{onStored}={}){
  return async(req,res)=>{
    const format=FORMATS[String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()],body=req.body;
    if(!format||!Buffer.isBuffer(body)||!body.length)return res.status(400).json({error:'Choose a JPEG, PNG or WebP image.'});
    if(body.length>MAX_BYTES)return res.status(413).json({error:'Image must be 5 MB or smaller.'});
    let image;
    try{
      const input=sharp(body,{failOn:'warning',limitInputPixels:20000000}),meta=await input.metadata();
      if(meta.format!==format||(meta.pages||1)!==1||meta.width<32||meta.height<32)throw Error('Unsupported image');
      image=await input.rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
    }catch{return res.status(400).json({error:'Use a valid static JPEG, PNG or WebP image, at least 32 × 32 pixels and up to 20 megapixels.'});}
    const filename=crypto.randomBytes(16).toString('hex')+'.webp',destination=path.join(uploadDir,filename);let stored=false;
    try{
      await fs.mkdir(uploadDir,{recursive:true});await fs.writeFile(destination,image,{flag:'wx'});stored=true;
      const url='/uploads/feed/'+filename;
      if(onStored)await onStored(url,req);
      return res.status(201).json({url});
    }catch(error){if(stored)await fs.unlink(destination).catch(()=>{});console.error('Feed image storage failed:',error.code||error.name);return res.status(500).json({error:'Unable to store the image. Please try again.'});}
  };
}
module.exports={createAnnouncementImageUpload,MAX_BYTES,FORMATS};
