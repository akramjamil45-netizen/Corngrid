# Community post image galleries

Live Feed accepts up to **5 JPEG, PNG or WebP images per community post**, each
up to 5 MB. The composer supports multiple selection, adding further images and
removing individual images. Editing loads the current attachments and permits
replacement/removal. A failed publish retains the composed text and uploaded images.

Multiple images use a horizontal, native scroll-snap carousel with a compact
image counter over the image. No scrollbar or separate navigation footer is shown.
Mobile/touch users swipe; small overlay arrows are available on desktop.
Keyboard users can use
Left/Right, Home and End on the image track. There is no automatic rotation.
Clicking an image opens the existing lightbox, extended with previous/next,
keyboard arrows, a counter and swipe navigation. Escape/Close returns focus.
Reduced-motion preferences are respected. Single-image posts retain their simple view.

## Storage and API compatibility

Apply `0018_feed_images.sql` from `migrations/postgres` before deploying the new
backend. SQLite creates the equivalent schema on startup. No new dependencies
or environment variables are required.

- `feed_post_images`: ordered attachments, constrained to positions 0–4 and unique
  paths within a post. No legacy rows are changed or images removed by migration.
- `feed_image_uploads`: provenance of new community uploads, associated with the
  authenticated user. Knowing another image URL does not authorize attaching it.
- `feed_posts.image_path` remains the first image for older clients. Existing
  single-image posts are returned as a one-item array without requiring backfill.
- `GET /api/feed`, `/api/feed/posts/:id` and `/api/feed/profile/:username` include
  ordered `imagePaths` alongside the existing `imagePath`.
- `POST /api/feed/uploads` continues accepting one raw image per request and
  returning `{url}`. The client uploads selected files sequentially, retaining
  successes if a later upload fails. Existing per-user upload throttling applies.
- `POST /api/feed/posts` accepts `{content,imagePaths:[]}`. The legacy `imagePath`
  field still works. Content remains required, limited to 4,000 characters.
- `PATCH /api/feed/posts/:id` preserves images if both image fields are omitted.
  An explicit array replaces their order; `[]` removes all. Only the owner may edit.
- The 5-image limit, duplicate rejection, local path format, file existence and
  upload ownership are enforced by the backend. Retaining an owned legacy post's
  existing image does not require a newly created provenance record.
- Post creation/edits and ordered attachment writes share a database transaction.
  Failure cannot leave a partially changed album or consume the daily post quota.

Community and announcement uploads share the existing Sharp decoding pipeline:
static images only, minimum 32 × 32, maximum 20 megapixels, resized within 1920 ×
1920, converted to WebP, metadata removed. Executable/animated or malformed files
are rejected. A provenance-write failure removes its newly written file.

Announcement management retains its existing single-image interface. Feed
rendering handles that image with the same backward-compatible fallback.
Removing an attachment or soft-deleting a post does not delete its physical file,
since it may still be referenced elsewhere. Automatic orphan cleanup is outside
this change. Existing authentication, CSRF, rate limits and 25-post daily quota remain.

## Verification and rollback

Run `npm test` in `Corngrid-web`; this uses the project's `test/*.test.js` glob.
Do not use bare `node --test`: legacy root/scripts matching its default discovery
can contact the running local service. New tests use isolated in-memory SQLite
and temporary upload folders. `marketing/verify-feed-images-postgres.cjs` verifies
the actual adapter/migration, ownership, ordering and rollback in a temporary
PostgreSQL schema, without writing production posts.

For a browser preview, run `node marketing/preview-feed-images.cjs` and open its
printed local URL. This runs the real UI against isolated fixture data.

To roll back, restore deployment backup files and restart CornGridWeb. Keep the
additive tables so all attachments/provenance remain recoverable; older clients
continue showing each post's first image. Optional schema removal must first back
up the attachment tables. It does not remove uploaded files.
