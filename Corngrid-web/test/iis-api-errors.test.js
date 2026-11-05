const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

for (const file of ['../../web.config', '../../web.config.xml', '../web.config']) {
  test(`IIS preserves API errors in ${file}`, () => {
    const config = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const apiScope = config.match(/<location\s+path="api"\s*>([\s\S]*?)<\/location>/);
    assert.ok(apiScope, 'API requests need their own error handling scope');
    assert.match(apiScope[1], /<httpErrors\s+existingResponse="PassThrough"\s*\/>/,
      'IIS must preserve JSON and status, including sandbox NO_CAPACITY (503)');
  });
}