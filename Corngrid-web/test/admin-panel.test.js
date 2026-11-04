const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.css'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.css'), 'utf8');

test('the admin shell exposes a mobile navigation toggle for the sidebar drawer', () => {
  // dashboard.css hides .sidebar below 850px, so the admin page needs its own
  // toggle button or the side menu is unreachable on phones.
  assert.match(dashboardCss, /\.sidebar \{[^}]*translateX\(-101%\)/);
  assert.match(adminHtml, /class="mobile-menu" id="admin-mobile-menu"/);
  assert.match(adminHtml, /aria-controls="admin-sidebar"/);
  assert.match(adminHtml, /<aside class="sidebar" id="admin-sidebar">/);
  assert.match(adminHtml, /<div class="overlay" id="admin-overlay" hidden><\/div>/);
});

test('the admin script wires the sidebar drawer open and closed', () => {
  assert.match(adminJs, /#admin-mobile-menu'\)\.addEventListener\('click'/);
  assert.match(adminJs, /#admin-overlay'\)\.addEventListener\('click'/);
  assert.match(adminJs, /sidebar\.classList\.toggle\('is-open', open\)/);
  // The closed drawer must be inert so keyboard users cannot tab into it.
  assert.match(adminJs, /sidebar\.inert = mobile && !open/);
  assert.match(adminJs, /event\.key === 'Escape'/);
});

test('the admin navigation includes a Reports page', () => {
  assert.match(adminHtml, /data-admin-page="reports"/);
  assert.match(adminHtml, /<section class="page" id="reports"/);
  assert.match(adminHtml, /id="admin-reports-list"/);
  // The routing table must know about the new page.
  assert.match(adminJs, /const pages = \['overview', 'subscriptions', 'support', 'email', 'reports', 'announcements', 'sandbox', 'ea-submissions', 'commissions'\]/);
  assert.match(adminJs, /if \(active === 'reports'\) loadReports\(\)/);
  assert.match(adminJs, /reports: 'Reports'/);
});

test('the admin reports queue reads and acts on the moderation endpoints', () => {
  assert.match(adminJs, /api\('\/api\/feed\/admin\/reports'\)/);
  assert.match(adminJs, /\/api\/feed\/admin\/reports\/\$\{encodeURIComponent\(resolveButton\.dataset\.reportResolve\)\}\/resolve/);
  assert.match(adminJs, /\/api\/feed\/admin\/content\/\$\{encodeURIComponent\(kind\)\}/);
});

test('the admin reports markup escapes user supplied report content', () => {
  // Reporter name, reason and content preview all come from the community.
  assert.match(adminJs, /escapeHtml\(report\.reason\)/);
  assert.match(adminJs, /escapeHtml\(report\.preview/);
  assert.match(adminJs, /escapeHtml\(report\.reporter/);
});

test('the admin reports panel is styled for the CornGrid admin surface', () => {
  assert.match(adminCss, /\.admin-reports-list/);
  assert.match(adminCss, /\.admin-report-item/);
  assert.match(adminCss, /\.admin-report-actions/);
});

test('the admin navigation includes a full email management page', () => {
  assert.match(adminHtml, /data-admin-page="email"/);
  assert.match(adminHtml, /<section class="page" id="email"/);
  assert.match(adminHtml, /id="email-compose-form"/);
  assert.match(adminHtml, /data-email-tab="templates"/);
  assert.match(adminHtml, /data-email-tab="history"/);
  assert.match(adminHtml, /data-email-tab="settings"/);
  assert.match(adminHtml, /id="email-settings-form"/);
  assert.match(adminJs, /if \(active === 'email'\) loadEmailPage\(\)/);
  assert.match(adminJs, /email: 'Email'/);
  assert.match(adminJs, /function loadEmailPage\(\)/);
  assert.match(adminCss, /\.email-tabs/);
  assert.match(adminCss, /\.email-recipient-list/);
});

test('the admin support inbox can search, filter, and safely render conversations', () => {
  assert.match(adminHtml, /id="admin-support-search"/);
  assert.match(adminHtml, /id="admin-support-filter"/);
  assert.match(adminHtml, /id="admin-support-char-count"/);
  assert.match(adminHtml, /id="admin-support-unread-summary"/);
  assert.match(adminJs, /function filterSupportConversations\(\)/);
  assert.match(adminJs, /escapeHtml\(conversation\.lastMessage\)/);
  assert.match(adminJs, /escapeHtml\(message\.message\)/);
  assert.match(adminJs, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(adminJs, /function supportAvatarContent\(/);
  assert.match(adminJs, /conversation\.avatarUrl/);
  assert.match(adminCss, /\.admin-support-avatar/);
  assert.match(adminCss, /\.admin-support-avatar img/);
  assert.match(adminCss, /\.admin-support-compose-field/);
});

test('every admin page stays inside the padded page wrapper', () => {
  assert.equal((adminHtml.match(/<section\b/g) || []).length, (adminHtml.match(/<\/section>/g) || []).length);
  assert.equal((adminHtml.match(/<div\b/g) || []).length, (adminHtml.match(/<\/div>/g) || []).length);

  const wrapperStart = adminHtml.indexOf('<div class="page-wrap">');
  const wrapperEnd = adminHtml.indexOf('<div class="toast-region"');
  assert.ok(wrapperStart > -1 && wrapperEnd > wrapperStart);

  for (const pageName of ['overview', 'support', 'email', 'reports', 'subscriptions', 'announcements']) {
    const pageStart = adminHtml.indexOf(`id="${pageName}"`);
    assert.ok(pageStart > wrapperStart && pageStart < wrapperEnd, `${pageName} must stay inside .page-wrap`);
  }
});
