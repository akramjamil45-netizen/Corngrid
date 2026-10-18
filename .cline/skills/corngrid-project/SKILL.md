---
name: corngrid-project
description: Use when implementing, debugging, testing, or reviewing the CornGrid EA website and dashboard, including Terminal Chat, user/admin support, MT5 data, authentication, account management, and PWA caching.
---

# CornGrid Project Assistant

Use this skill for engineering work in the CornGrid website repository. The repository root contains `Corngrid-web/` (the Express/SQLite application) and `sw.js` (the root service worker). The application serves its pages and frontend assets from `Corngrid-web/public/`.

## Start by understanding the current project

1. Confirm the workspace and inspect `git status` before editing. The worktree may contain user changes; preserve them and do not reset, checkout, or overwrite unrelated work.
2. Read the affected implementation, its callers/routes, and the closest tests before deciding on a change. Search for existing helpers and established patterns first.
3. Treat current source code as authoritative. Feature notes in this skill are orientation only and may become outdated.
4. Keep changes focused, maintain existing behavior, and update directly related tests and user-facing documentation when relevant.

## Project map

- `Corngrid-web/server.js`: Express app, SQLite connection, middleware, route registration, and static page serving.
- `Corngrid-web/mt5-api.js`: MT5 account, positions, deals, preferences, portfolio, and user-related database schema.
- `Corngrid-web/chat-api.js`: authenticated user direct messages and support-message APIs.
- `Corngrid-web/admin-api.js`: administrator-only overview, support inbox, user management, and trading overview APIs.
- `Corngrid-web/user-auth.js`: user bearer/cookie authentication, session-version checks, and suspended/deleted-account access checks.
- `Corngrid-web/admin-auth.js`: separate administrator authentication. Admin identities are not user records.
- `Corngrid-web/public/dashboard.html`, `dashboard.js`, `dashboard.css`: user dashboard and Terminal Chat.
- `Corngrid-web/public/admin.html`, `admin.js`, `admin.css`: administrator interface.
- `Corngrid-web/test/`: Node.js built-in test-runner tests for APIs and authentication.
- `sw.js`: PWA asset caching at the repository root. Bump the cache version when a change requires old installed clients to discard cached assets.

## Authentication, data, and safety

- Protect user endpoints with the existing user-auth middleware and administrator endpoints with `verifyAdminToken`. Never authorize admin APIs with a user token or treat an admin as a row in `users`.
- Respect cookie same-origin protections, auth-version checks, account suspension checks, endpoint rate limits, and parameterized SQLite queries.
- Support chat is a separate user/admin conversation, not a direct message to a fabricated user account. Keep the sender role explicit and scope every query to the authenticated user or authorized admin.
- Never expose full MT5 account identifiers, tickets, EA credentials, passwords, JWTs, or environment secrets to the browser. Use masked identifiers where an overview needs to associate records.
- Deleting a user can cascade into linked trading and support data. Preserve explicit confirmation and clear UI warnings for destructive actions.
- Surface operational errors through the existing response/logging patterns. Do not silently swallow failed requests or present a failed action as successful.
- Escape untrusted text before inserting it into HTML. Prefer `textContent` or the frontend's existing HTML escaping helper.

## Frontend and PWA behavior

- Keep mobile layouts usable, especially the Terminal Chat conversation pane and composer.
- If changing frontend behavior, check both event wiring in `dashboard.js`/`admin.js` and matching elements in the HTML. Avoid duplicate or missing DOM IDs.
- Authenticated API responses must not be cached. Keep API requests network-only and use the existing same-origin credentials behavior.
- If JavaScript or CSS was stale due to browser/PWA caching, update the asset query version in the relevant HTML and assess whether `sw.js` cache version must also change. Do not use cache version bumps as a substitute for fixing event wiring or API errors.
- For chat work, verify opening a conversation, loading history, sending a message, unread counts/read state, refresh/polling, and mobile back navigation as applicable.

## Validation

Run commands from `Corngrid-web/` unless the task requires otherwise:

```powershell
node --check public\dashboard.js
npm test
```

For server/API/auth changes, also run `node --check` on every modified server-side JavaScript file. Add or update focused API tests for authorization, invalid input, normal success paths, and destructive or suspension behavior. Prefer the smallest relevant checks first, then run `npm test` for integration confidence.

When a browser preview is available, validate the actual user flow in an authenticated session rather than relying only on static inspection. Report any unavailable authenticated setup clearly.

## Working style

- Reply in the user's language when practical; this project commonly uses Malay and English UI copy.
- Make the requested change rather than only proposing a plan, unless the user asks for advice only.
- Do not commit, deploy, or change production data unless explicitly requested.
- Summarize changed behavior and exact validation results when finished.
