// Reuse the existing EA footer and its translations, including real resource links.
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync('corngrid-ea.html', 'utf8').match(/<footer class="footer-section">[\s\S]*?<\/footer>/)[0];
const source = fs.readFileSync('script.js', 'utf8').match(/const translations = (\{[\s\S]*?\n\});/)[1];
const translations = vm.runInNewContext('(' + source + ')');
const plain = value => value.replace(/<[^>]*>/g, '');
module.exports = {
  register(add) {
    for (const match of template.matchAll(/data-i18n="([^"]+)"/g)) {
      const key = match[1];
      if (translations.bm[key] && translations.en[key]) add('ea-footer.' + key, plain(translations.bm[key]), plain(translations.en[key]));
    }
  },
  render(dictionary, escape) {
    return template.replace(/href="#/g, 'href="/corngrid-ea#')
      .replace(/\/images\/CornGrid logo 4k.jpg/g, '/images/Corngrid%20logo%204k.jpg')
      .replace(/<([a-z0-9]+)([^>]*?)data-i18n="([^"]+)"([^>]*)>[\s\S]*?<\/\1>/g,
        (match, tag, before, key, after) => dictionary['ea-footer.' + key]
          ? '<' + tag + before + 'data-site-i18n="ea-footer.' + key + '"' + after + '>' + escape(dictionary['ea-footer.' + key]) + '</' + tag + '>' : match);
  }
};
