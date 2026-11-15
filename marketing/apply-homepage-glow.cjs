const fs = require('node:fs');
for (const file of ['index.html', 'en/index.html']) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('class="gold"')) throw new Error('Homepage highlight not found: ' + file);
  const updated = source.replace('class="gold"', 'class="gold highlight-gold"')
    .replace(/infrastructure\.css\?v=[^"\s]+/, 'infrastructure.css?v=20261106-gold-glow1');
  fs.writeFileSync(file, updated);
}
