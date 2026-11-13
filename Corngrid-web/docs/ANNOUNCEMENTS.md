# Announcement images

Admin → Announcements supports one optional image per announcement. Select
**Add image**, review the local preview, then publish. Existing announcements
support **Edit → Replace image / Remove image → Save changes**. Canceling an edit
does not change the published image. Text and pin edits preserve the attachment.

JPEG, PNG and static WebP are accepted, up to 5 MB, minimum 32 × 32 pixels and
maximum 20 megapixels. The server decodes actual image bytes, rejects corrupt,
animated or mismatched content, applies orientation, removes metadata and writes
a WebP bounded to 1920 pixels. Filenames are randomly generated server-side.

Images upload only when Publish/Save is selected. After an upload succeeds, the
composer retains its URL if publishing fails, allowing a retry without uploading
the same draft image again. A preview alone does not create a server file.

The API reuses existing admin authentication, cookie CSRF checks, upload limits,
the feed image directory and `feed_posts.image_path`. No database migration,
environment variable or new dependency is required. Live Feed already renders
this field and provides its existing image lightbox.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/feed/announcements/uploads` | Admin-only raw JPEG/PNG/WebP upload; returns `{url}` |
| POST | `/api/feed/announcements` | Existing publish endpoint; optional uploaded `imagePath` |
| PATCH | `/api/feed/announcements/:id` | Omit `imagePath` to preserve; string to replace; `null` to detach |

Only existing local feed upload paths may be attached. External URLs, path
traversal and missing files are rejected. Removing a reference or deleting a
post follows the existing soft-delete/file-retention behavior; it does not
immediately erase shared uploaded files. Feed image URLs use the existing public
upload serving policy. Include `public/uploads/feed` in backups.

Tests: `node --test test/announcement-images.test.js test/feed-api.test.js`.
`marketing/verify-announcement-images-postgres.cjs` checks the actual PostgreSQL
adapter in a disposable schema. `marketing/preview-announcement-images.cjs`
serves the real UI against an in-memory database for browser verification.
Neither helper publishes to the production feed.
