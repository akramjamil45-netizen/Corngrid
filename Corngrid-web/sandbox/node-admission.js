'use strict';
function loadPolicy(env=process.env){
 const positive=(key,fallback)=>{if(env[key]==null||env[key]==='')return fallback;const value=Number(env[key]);if(!Number.isFinite(value)||value<=0)throw Error('Invalid resource policy: '+key);return value;};
 const allowedPlatforms=(env.SANDBOX_ALLOWED_NODE_PLATFORMS||'windows,linux').split(',').map(s=>s.trim());if(!allowedPlatforms.length||allowedPlatforms.some(p=>!['windows','linux'].includes(p)))throw Error('Invalid allowed node platforms.');
 const maxCpuPercent=positive('SANDBOX_MAX_CPU_PERCENT',90);if(maxCpuPercent>100)throw Error('Invalid CPU threshold.');
 return {minFreeRamMb:positive('SANDBOX_MIN_FREE_RAM_MB',256),instanceRamMb:positive('SANDBOX_INSTANCE_RAM_MB',256),minFreeDiskMb:positive('SANDBOX_MIN_FREE_DISK_MB',1024),instanceDiskMb:positive('SANDBOX_INSTANCE_DISK_MB',512),maxCpuPercent,allowedPlatforms};
}
const metric=value=>value==null||value===''||typeof value==='boolean'?null:Number.isFinite(Number(value))?Number(value):null;
function nodeAdmission(node,occupied=0,policy=loadPolicy()){
 const platform=/^(?:Windows_NT|win32|Windows\b)/i.test(node.os_version||'')?'windows':/^linux\b/i.test(node.os_version||'')?'linux':null,reasons=[];
 if(!platform||!policy.allowedPlatforms.includes(platform))reasons.push('PLATFORM_UNSUPPORTED');
 const total=metric(node.ram_mb),used=metric(node.memory_used_mb),disk=metric(node.disk_free_mb),cpu=metric(node.cpu_percent),reported=metric(node.running_instances);
 const known=total!=null&&total>0&&used!=null&&used>=0&&used<=total&&disk!=null&&disk>=0&&cpu!=null&&cpu>=0&&cpu<=100&&reported!=null&&reported>=0;
 const reservations=Math.max(0,Math.max(0,Number(occupied)||0)-Math.max(0,reported||0));
 const freeRamMb=known?Math.max(0,total-used-reservations*policy.instanceRamMb):null,freeDiskMb=known?Math.max(0,disk-reservations*policy.instanceDiskMb):null;
 if(!known)reasons.push('TELEMETRY_UNAVAILABLE');else{
  if(freeRamMb<policy.minFreeRamMb+policy.instanceRamMb)reasons.push('RAM_LOW');
  if(freeDiskMb<policy.minFreeDiskMb+policy.instanceDiskMb)reasons.push('DISK_LOW');
  if(cpu>=policy.maxCpuPercent)reasons.push('CPU_BUSY');
 }
 return {eligible:reasons.length===0,reasons,platform,reservedSlots:reservations,freeRamMb,freeDiskMb};
}
module.exports={loadPolicy,nodeAdmission};
