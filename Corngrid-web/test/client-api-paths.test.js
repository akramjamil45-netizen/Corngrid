const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const API_BASE = '/api';

// Folders served by express.static that the client may legitimately fetch.
const STATIC_PREFIXES = ['/uploads/', '/download/', '/files/', '/video/', '/images/'];

// The server registers every API route directly on the express app (there are
// no mounted routers), so the literal first argument of
// app.get/post/patch/put/delete is the real route path.
function collectServerRoutes() {
  const routes = [];
  const files = fs.readdirSync(ROOT_DIR).filter(name => name.endsWith('.js'));
  const moduleDirs = ['subscriptions'];
  const routePattern = /app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
  const sources = files.map(file => ({ file, source: fs.readFileSync(path.join(ROOT_DIR, file), 'utf8') }));
  for (const dirName of moduleDirs) {
    const dir = path.join(ROOT_DIR, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
      sources.push({ file: path.join(dirName, name), source: fs.readFileSync(path.join(dir, name), 'utf8') });
    }
  }
  for (const { file, source } of sources) {
    let match;
    while ((match = routePattern.exec(source)) !== null) {
      routes.push({ method: match[1].toUpperCase(), route: match[2], file });
    }
  }
  return routes;
}

function clientFiles() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(PUBLIC_DIR, name));
}

// Read a string or template literal starting at `start`. Nested templates and
// `${...}` placeholders are copied verbatim so they can be recognised later.
function readLiteral(source, start) {
  const quote = source[start];
  let i = start + 1;
  let out = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { out += ch + (source[i + 1] ?? ''); i += 2; continue; }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      let j = i + 2;
      let depth = 1;
      while (j < source.length && depth > 0) {
        const inner = source[j];
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        else if (inner === "'" || inner === '"' || inner === '`') {
          const q = inner;
          j += 1;
          while (j < source.length && source[j] !== q) {
            if (source[j] === '\\') j += 1;
            j += 1;
          }
        }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return { value: out, end: i };
}

// Locate the `request` / `api` helper definitions and record whether each one
// prepends the '/api' base to the path it is given. Also returns the body
// range so helper internals can be excluded from the call-site scan.
function findHelpers(source) {
  const helpers = {};
  const pattern = /(?:async\s+)?function\s+(request|api)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    // Skip the parameter list to find the body's opening brace.
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const open = source.indexOf('{', i);
    if (open === -1) continue;
    depth = 0;
    let j = open;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(open, j + 1);
    helpers[match[1]] = {
      prepends: /\$\{\s*API(?:_URL)?\s*\}/.test(body) || /\bAPI(?:_URL)?\s*\+/.test(body),
      start: open,
      end: j + 1
    };
  }
  return helpers;
}

// Replace helper bodies with spaces so the helper's own fetch() call is not
// mistaken for a call site.
function blankHelperBodies(source, helpers) {
  let out = source;
  for (const helper of Object.values(helpers)) {
    out = out.slice(0, helper.start) + ' '.repeat(helper.end - helper.start) + out.slice(helper.end);
  }
  return out;
}

// Collect request/api/fetch call sites whose first argument is a literal we
// can read statically.
function collectClientCalls(source) {
  const calls = [];
  const pattern = /\b(request|api|fetch)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let i = match.index + match[0].length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    const literal = readLiteral(source, i);
    calls.push({ helper: match[1], literal: literal.value, isTemplate: quote === '`' });
    pattern.lastIndex = literal.end;
  }
  return calls;
}

// Turn a client literal into the effective request path.
function resolvePath(literal, isTemplate, helper) {
  let value = literal;
  if (isTemplate) {
    value = value.replace(/\$\{\s*API(?:_URL)?\s*\}/g, API_BASE);
  }
  if (helper === 'fetch') {
    // A raw fetch() call is used verbatim.
    return { path: value };
  }
  if (helper && helper.prepends) {
    if (value.startsWith(API_BASE)) return { error: 'double /api prefix' };
    return { path: API_BASE + value };
  }
  return { path: value };
}

// Split a path into segments. Segments containing an interpolation are marked
// dynamic. The query string is only cut at a '?' that sits outside a
// placeholder, because placeholders may themselves contain '?'.
function segmentsOf(value) {
  let depth = 0;
  let queryStart = -1;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '$' && value[i + 1] === '{') { depth += 1; i += 1; continue; }
    if (ch === '}' && depth > 0) { depth -= 1; continue; }
    if (ch === '?' && depth === 0) { queryStart = i; break; }
  }
  const clean = queryStart === -1 ? value : value.slice(0, queryStart);
  const parts = [];
  let rest = clean;
  while (rest.length) {
    if (rest[0] !== '/') break;
    const match = /^\/([^/]*)/.exec(rest);
    if (!match) break;
    const segment = match[1];
    parts.push({ dynamic: segment.includes('${'), value: segment });
    rest = rest.slice(match[0].length);
  }
  return parts;
}

// A dynamic client segment may match one route segment, or a ':param' segment,
// or be spread across several segments when the client builds a sub-path.
function matchesRoute(pathParts, routeParts) {
  function walk(p, r) {
    if (r === routeParts.length) return p === pathParts.length;
    const pathPart = pathParts[p];
    if (!pathPart) return false;
    if (pathPart.dynamic) {
      // Try consuming 1..n client segments for this route segment.
      for (let take = 1; take <= pathParts.length - p; take += 1) {
        if (walk(p + take, r + 1)) return true;
      }
      return false;
    }
    const routePart = routeParts[r];
    if (routePart.startsWith(':')) return walk(p + 1, r + 1);
    if (pathPart.value !== routePart) return false;
    return walk(p + 1, r + 1);
  }
  return walk(0, 0);
}

test('client request paths resolve to registered server routes', () => {
  const routes = collectServerRoutes();
  assert.ok(routes.length > 0, 'expected the server to register routes');

  const problems = [];
  for (const file of clientFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    const helpers = findHelpers(source);
    const scanned = blankHelperBodies(source, helpers);

    for (const call of collectClientCalls(scanned)) {
      const helper = call.helper === 'fetch' ? null : helpers[call.helper];
      const resolved = resolvePath(call.literal, call.isTemplate, helper);
      if (resolved.error) {
        problems.push(`${name}: ${call.helper}("${call.literal}") ${resolved.error}`);
        continue;
      }
      const effective = resolved.path;
      if (!effective.startsWith('/')) continue;

      const pathParts = segmentsOf(effective);
      const matched = routes.some(route => {
        const routeParts = route.route.split('/').filter(Boolean);
        return matchesRoute(pathParts, routeParts);
      });
      if (matched) continue;

      if (effective === API_BASE || effective.startsWith(API_BASE + '/')) {
        problems.push(`${name}: "${effective}" has no matching server route`);
      } else if (!STATIC_PREFIXES.some(prefix => effective.startsWith(prefix))) {
        // Paths outside the /api namespace only make sense for the static
        // asset folders; anything else is a missing /api prefix.
        problems.push(`${name}: "${effective}" does not target the /api namespace`);
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved client API paths:\n${problems.join('\n')}`);
});

test('economic news client calls the /api prefixed user endpoints', () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'economic-news.js'), 'utf8');

  // These two calls used to omit the '/api' prefix and resolved to 404s,
  // which silently broke preference loading and saving on the dashboard.
  assert.ok(
    /request\('\/api\/me'\)/.test(source),
    'loadPreferences must call /api/me'
  );
  assert.ok(
    /request\('\/api\/user\/preferences'/.test(source),
    'savePreferences must call /api/user/preferences'
  );

  assert.ok(
    !/request\('\/me'\)/.test(source),
    'do not call the unprefixed /me route'
  );
  assert.ok(
    !/request\('\/user\/preferences'/.test(source),
    'do not call the unprefixed /user/preferences route'
  );
});

test('the server exposes the economic news client routes', () => {
  const routes = collectServerRoutes();
  for (const route of ['/api/me', '/api/user/preferences', '/api/economic-calendar']) {
    assert.ok(
      routes.some(entry => entry.route === route),
      `the server must expose ${route}`
    );
  }
});
