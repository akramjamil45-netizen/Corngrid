# Support chat UX and history deletion

Deployed 2026-11-05. Eight production files were backed up and hash-verified; CornGridWeb restarted successfully and its health endpoint returned HTTP 200.

- Admin support retains search, unread filtering and live refresh. Mobile now switches between inbox and conversation with a back action and focus restoration. Messages use larger typography, date dividers, a scrollable keyboard-focusable log, and a recent-message count rather than an unconditional read label.
- Admin can delete the selected support thread. Dashboard users can delete their own thread from Terminal Chat → CornGrid Support. Both actions require explicit confirmation and permanently remove the thread for both participants; other conversations and direct messages are preserved.
- User ownership comes exclusively from the authenticated session. Caller-supplied user IDs cannot select another owner's support history. Admin deletion validates the target ID and existing user. Both APIs reuse existing authentication/CSRF checks and require JSON `confirm: true`.
- Buttons show pending/empty states, lists and unread counts refresh, and stale pending history responses are invalidated during deletion. Empty support threads remain available for new messages.
- No database schema, account, subscription or MT5 changes. No production messages were deleted during development or deployment.

Validation: full sequential Node suite passed 157/157; final focused suite passed 12/12 after UI touch-ups. Local browser fixtures verified mobile layout, cancellation (no DELETE), confirmed deletion (one DELETE), empty states, disabled buttons, and return to inbox in admin and dashboard. These fixtures were confined to the local preview. Production admin/dashboard HTML and versioned scripts returned HTTP 200 with the new controls. Both production deletion endpoints returned HTTP 401 to unauthenticated requests.

Production backup: `C:\Users\mohamad akram\AppData\Local\Temp\CornGrid-support-repair-20261105-123845`.

Changed runtime files: `chat-api.js`, `admin-api.js`, `public/admin.html`, `public/admin.js`, `public/admin.css`, `public/dashboard.html`, `public/dashboard.js`, `public/dashboard.css`. Deployment helper: `marketing/deploy-support-repair.ps1`. Extended API tests: `test/admin-api.test.js`, `test/chat-api.test.js`.
