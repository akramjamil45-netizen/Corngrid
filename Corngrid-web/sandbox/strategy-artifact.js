'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function artifactReady(strategy,root=path.join(__dirname,'../storage')){
  if(!strategy?.ea_file_path)return false;
  const file=path.resolve(root,strategy.ea_file_path),relative=path.relative(path.resolve(root),file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||path.extname(file).toLowerCase()!=='.ex5')return false;
  try{const info=await fs.stat(file);return info.isFile()&&info.size>0;}catch{return false;}
}
module.exports={artifactReady};
