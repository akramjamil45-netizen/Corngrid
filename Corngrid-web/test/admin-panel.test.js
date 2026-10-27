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
  assert.match(adminJs, /const pages = \['overview', 'subscriptions', 'support', 'reports', 'announcements'\]/);
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
