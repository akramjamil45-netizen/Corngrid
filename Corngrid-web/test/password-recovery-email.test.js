const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPasswordRecoveryEmail } = require('../password-recovery-email');

test('recovery email keeps the exact reset token in HTML and plain-text alternatives', () => {
  const resetUrl = 'https://example.test/reset-password.html?token=' + 'a'.repeat(64) + '&source=email';
  const email = buildPasswordRecoveryEmail({ resetUrl });
  const links = [...email.html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  assert.deepEqual(links, [resetUrl, resetUrl]);
  assert.ok(email.text.includes(resetUrl));
  assert.match(email.html, /15 minutes/);
  assert.match(email.text, /only be used once/);
});

test('email links cannot inject markup and non-web schemes are rejected', () => {
  const email = buildPasswordRecoveryEmail({ resetUrl: 'https://example.test/reset-password.html?token=abc&label=\'<img src=x onerror=alert(1)>' });
  assert.ok(!email.html.includes('<img'));
  assert.ok(!email.html.includes('label=\''));
  assert.throws(() => buildPasswordRecoveryEmail({ resetUrl: 'javascript:alert(1)' }), /Invalid password recovery URL/);
});
