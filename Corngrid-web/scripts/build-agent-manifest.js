'use strict';
const path=require('node:path'),{atomicJson}=require('../agent/update-protocol'),{sourceManifest}=require('../sandbox/node-updates');
const source=path.join(__dirname,'../agent'),manifest=sourceManifest(source);
atomicJson(path.join(source,'RELEASE.json'),manifest);console.log('Built agent source manifest '+manifest.id+' ('+manifest.files.length+' files).');
