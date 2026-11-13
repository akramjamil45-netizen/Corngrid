'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {dbRun,dbGet,dbAll}=require('./db-async');
const MAX_IMAGES=5,SAFE_IMAGE=/^\/uploads\/feed\/[a-f0-9]{32}\.(jpg|png|webp)$/;
const invalid=message=>{throw Object.assign(Error(message),{status:400});};
function readImages(body){
 if(!Object.hasOwn(body||{},'imagePaths')){
  if(!Object.hasOwn(body||{},'imagePath'))return undefined;
  if(body.imagePath==null||body.imagePath==='')return [];
  body={imagePaths:[body.imagePath]};
 }
 const images=body.imagePaths;
 if(!Array.isArray(images)||images.length>MAX_IMAGES)invalid('Attach up to 5 images per post.');
 if(images.some(src=>typeof src!=='string'||!SAFE_IMAGE.test(src))||new Set(images).size!==images.length)invalid('Choose valid uploaded images without duplicates.');
 if(body.imagePath!=null&&body.imagePath!==images[0])invalid('Conflicting image references.');
 return images;
}
function createFeedImages(db,uploadDir){
 async function shapePosts(rows,shapePost){
  if(!rows.length)return [];
  const images=await dbAll(db,`SELECT post_id,image_path FROM feed_post_images WHERE post_id IN (${rows.map(()=>'?').join(',')}) ORDER BY post_id,display_order`,rows.map(row=>row.id)),groups=new Map();
  for(const image of images){if(!groups.has(image.post_id))groups.set(image.post_id,[]);groups.get(image.post_id).push(image.image_path);}
  return rows.map(row=>({...shapePost(row),imagePaths:groups.get(row.id)||(row.image_path?[row.image_path]:[])}));
 }
 async function validate(images,userId,retained=[]){
  for(const src of images){
   if(retained.includes(src))continue; // Existing legacy attachments remain editable even if their old file is unavailable.
   const owned=await dbGet(db,'SELECT user_id FROM feed_image_uploads WHERE image_path=? AND user_id=?',[src,userId]);
   let exists=false;try{exists=(await fs.stat(path.join(uploadDir,path.basename(src)))).isFile();}catch{}
   if(!owned||!exists)invalid('Upload each new image from your own account before attaching it.');
  }
 }
 async function replace(postId,images){
  await dbRun(db,'DELETE FROM feed_post_images WHERE post_id=?',[postId]);
  for(const [position,src] of images.entries())await dbRun(db,'INSERT INTO feed_post_images(post_id,display_order,image_path) VALUES(?,?,?)',[postId,position,src]);
 }
 const stored=(url,req)=>dbRun(db,'INSERT INTO feed_image_uploads(image_path,user_id,created_at) VALUES(?,?,?)',[url,req.user.id,Date.now()]);
 return {shapePosts,validate,replace,stored};
}
module.exports={createFeedImages,readImages,MAX_IMAGES};
