const fs = require('node:fs');
const copy = {
 en: {
  'hero.title': 'Your strategy.', 'hero.gold': 'Our infrastructure.',
  'hero.description': 'Connect MT5, choose a strategy and manage your trading sandbox in one place.',
  'hero.benefit1': 'No VPS setup', 'hero.benefit2': 'Hosted MT5',
  'hero.risk': 'Trading involves risk. Returns are not guaranteed.',
  'hero.explore': 'Inside your sandbox', 'features.more': 'Explore all features',
  'architecture.expand': 'Behind the scenes', 'partner.expand': 'For EA developers',
  'cta.how': 'How it works',
  'workflow.title': 'From account to automation.', 'workflow.description': 'A simple setup, managed from your dashboard.',
  'step.0.description': 'Choose a plan and complete payment approval.',
  'step.1.title': 'Connect MT5', 'step.1.description': 'Add your broker server and trading account.',
  'step.2.description': 'Pick an available EA and supported pair.',
  'step.3.title': 'We prepare your sandbox', 'step.3.description': 'CornGrid sets up the terminal, EA and preset.',
  'step.4.title': 'Activate & monitor', 'step.4.description': 'Activate in your dashboard once MT5 is connected. Entries follow the strategy rules.',
  'features.title': 'Less setup. More control.', 'features.description': 'The essentials for your hosted trading workspace.',
  'feature.0.title': 'No VPS setup', 'feature.0.description': 'CornGrid manages the server for supported strategies.',
  'feature.1.title': 'EA setup included', 'feature.1.description': 'Your selected EA and preset are deployed for you.',
  'feature.3.title': 'One dashboard', 'feature.3.description': 'Check your accounts, sandbox and trading activity together.',
  'sandbox.title': 'Your MT5 workspace, managed.', 'sandbox.description': 'A hosted MT5 terminal for your selected strategy. Connect your account and manage it from the dashboard.',
  'pricing.title': 'Choose your access.', 'pricing.description': 'See current plans, prices and account limits in your dashboard.',
  'terminal.title': 'Everything in one place.', 'terminal.description': 'Manage accounts, strategies and sandbox controls. View trading activity when your EA sends data.'
 },
 ms: {
  'hero.title': 'Strategi anda.', 'hero.gold': 'Kami urus MT5.',
  'hero.description': 'Sambungkan MT5, pilih strategi dan urus sandbox trading anda dalam satu platform.',
  'hero.benefit1': 'Tanpa setup VPS', 'hero.benefit2': 'MT5 terurus',
  'hero.risk': 'Trading melibatkan risiko. Tiada jaminan pulangan.',
  'hero.explore': 'Di dalam sandbox anda', 'features.more': 'Terokai semua fungsi',
  'architecture.expand': 'Di sebalik platform', 'partner.expand': 'Untuk pembangun EA',
  'cta.how': 'Cara berfungsi',
  'workflow.title': 'Dari akaun ke automasi.', 'workflow.description': 'Setup mudah, diurus melalui dashboard anda.',
  'step.0.description': 'Pilih pelan dan lengkapkan kelulusan pembayaran.',
  'step.1.title': 'Sambungkan MT5', 'step.1.description': 'Masukkan server broker dan akaun trading anda.',
  'step.2.description': 'Pilih EA yang tersedia dan pair yang disokong.',
  'step.3.title': 'Kami sediakan sandbox', 'step.3.description': 'CornGrid menyediakan terminal, EA dan preset.',
  'step.4.title': 'Aktifkan & pantau', 'step.4.description': 'Aktifkan melalui dashboard setelah MT5 bersambung. Entry mengikut peraturan strategi.',
  'features.title': 'Kurang setup. Lebih kawalan.', 'features.description': 'Keperluan utama untuk ruang trading terurus anda.',
  'feature.0.title': 'Tanpa setup VPS', 'feature.0.description': 'CornGrid mengurus server untuk strategi yang disokong.',
  'feature.1.title': 'Setup EA disertakan', 'feature.1.description': 'EA dan preset pilihan anda dipasang secara automatik.',
  'feature.3.title': 'Satu dashboard', 'feature.3.description': 'Pantau akaun, sandbox dan aktiviti trading bersama.',
  'sandbox.title': 'Ruang MT5 anda, terurus.', 'sandbox.description': 'Terminal MT5 terurus untuk strategi pilihan anda. Sambungkan akaun dan urus melalui dashboard.',
  'pricing.title': 'Pilih akses anda.', 'pricing.description': 'Semak pelan, harga dan had akaun terkini dalam dashboard.',
  'terminal.title': 'Semuanya di satu tempat.', 'terminal.description': 'Urus akaun, strategi dan kawalan sandbox. Lihat aktiviti trading apabila EA menghantar data.'
 }
};
const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for (const [language, updates] of Object.entries(copy)) {
 const locale = 'locales/' + language + '.json';
 const dictionary = {...JSON.parse(fs.readFileSync(locale,'utf8')), ...updates};
 fs.writeFileSync(locale, JSON.stringify(dictionary,null,2)+'\n');
 const file = language === 'en' ? 'en/index.html' : 'index.html';
 let html = fs.readFileSync(file,'utf8');
 for (const [key,value] of Object.entries(updates)) {
  const escapedKey=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  html=html.replace(new RegExp('(<([a-z][a-z0-9]*)\\b[^>]*data-site-i18n="'+escapedKey+'"[^>]*>)[\\s\\S]*?(<\\/\\2>)','g'),(_m,open,_tag,close)=>open+escape(value)+close);
 }
 html=html.replace(/<p class="hero-note"[^>]*>[\s\S]*?<\/p>/,
  '<div class="hero-benefits"><span data-site-i18n="hero.benefit1">'+escape(updates['hero.benefit1'])+'</span><span data-site-i18n="hero.benefit2">'+escape(updates['hero.benefit2'])+'</span></div>');
 const heroStart=html.indexOf('<div class="infra-flow"');
 const heroEnd=html.indexOf('</section>',heroStart);
 const tail=html.slice(heroStart,heroEnd);
 const boundary=tail.lastIndexOf('</div>');
 // The final div closes hero-grid; the previous div closes the illustration.
 const flow=tail.slice(0,boundary);
 if(!flow.endsWith('</div>'))throw Error('Hero illustration boundary missing');
 html=html.slice(0,heroStart)+'<details class="infra-mobile-details hero-flow-details" open><summary data-site-i18n="hero.explore">'+escape(updates['hero.explore'])+'</summary>'+flow+'</details>'+html.slice(heroStart+boundary);
 html=html.replace(/<div class="infra-features">((?:<article class="infra-feature">[\s\S]*?<\/article>)+)<\/div>/,(_match,content)=>{
  const cards=content.match(/<article class="infra-feature">[\s\S]*?<\/article>/g);
  if(cards.length!==10)throw Error('Expected ten feature cards');
  const primary=cards.filter((_,i)=>[0,1,3].includes(i));const more=cards.filter((_,i)=>![0,1,3].includes(i));
  return '<div class="infra-features">'+primary.join('')+'</div><details class="infra-mobile-details infra-feature-details" open><summary data-site-i18n="features.more">'+escape(updates['features.more'])+'</summary><div class="infra-features">'+more.join('')+'</div></details>';
 });
 for(const [id,key] of [['architecture','architecture.expand'],['partners','partner.expand']]){
  const pattern=new RegExp('(<section id="'+id+'" class="[^"]*)(">)([\\s\\S]*?)(<\\/section>)');
  html=html.replace(pattern,(_m,start,close,content,end)=>start+' infra-fold-section'+close+'<details class="infra-mobile-details" open><summary data-site-i18n="'+key+'">'+escape(updates[key])+'</summary>'+content+'</details>'+end);
 }
 html=html.replace(/infrastructure\.css\?v=[^"\s]+/,'infrastructure.css?v=20261111-simple-home1').replace(/site\.js\?v=[^"\s]+/,'site.js?v=20261111-simple-home1');
 fs.writeFileSync(file,html);
}
