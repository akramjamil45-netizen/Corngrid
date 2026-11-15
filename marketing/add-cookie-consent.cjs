const fs=require('node:fs');
for(const file of ['index.html','en/index.html']){
 let html=fs.readFileSync(file,'utf8');
 if(html.includes('cookie-consent.js'))throw Error('Consent already installed: '+file);
 html=html.replace('</head>','<link rel="stylesheet" href="/cookie-consent.css?v=20261111-1"><script src="/cookie-consent.js?v=20261111-1" defer></script></head>');
 fs.writeFileSync(file,html);
}
