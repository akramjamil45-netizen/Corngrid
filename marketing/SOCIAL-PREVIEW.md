# CornGrid public link previews

Static Open Graph and X/Twitter large-image metadata are included in both the homepage and English page. Crawlers do not need JavaScript or authentication. Canonical URLs use HTTPS.

## Approved server-comic artwork

The user selected the attached server-comic design with "Gunakan design ini". The supplied file was named 1000259805.png, but its actual bytes are JPEG. It is preserved under the correct extension at `marketing/assets/social/corngrid-comic-approved-v2.jpg`. The public copy is `images/social/corngrid-infrastructure-comic-v2.jpg`.

- SHA-256: `2c0073db3109d49b7f01aa407b4894386bbd89622ccb1d4f9a05c22ccf235d72`
- Actual format/dimensions: JPEG, 1280 x 673, 148313 bytes.
- Source and public copy must remain byte-for-byte identical to the approved upload.
- No cropping, resizing, regenerated lettering, logo changes or recompression.
- The user subsequently requested English on the main link. Both `/` and `/en/` now share the English comic, title, description, alt text and `en_US` Open Graph locale. Each URL retains its own canonical URL. Older Malay artwork is retained for existing posts.
- English source: `marketing/assets/social/corngrid-comic-approved-en-v3.jpg`; public copy: `images/social/corngrid-infrastructure-comic-en-v3.jpg`.
- English SHA-256: `ccbc65fc7b6e59b7a4ef489d887a052c845ea4501410e76e6a8905cedecfb7a3`; JPEG, 1280 x 673, 152425 bytes. It is byte-for-byte identical to the supplied `1000259839.png` (which contains JPEG bytes).
- English wording: "YOUR TRADING STRATEGY. WE RUN IT ON MT5." / "Connect your account. Choose a strategy. Run your MT5 sandbox with us."
- The earlier v1 PNGs stay public because older posts may reference them.

`marketing/social-preview.cjs` supplies metadata and copies the approved artwork after checking its source hash, MIME format and dimensions. It refuses different bytes at an existing public version. `marketing/build.js` imports the same `socialMetadata()` function so future marketing builds retain these tags.

```powershell
node marketing/social-preview.cjs --update-pages
node marketing/verify-social-preview.cjs
node marketing/preview.js
node marketing/verify-social-preview.cjs --local
```

The main-link update changes social tags and refreshes the `site.js` cache version. Visible page content and navigation stay intact. The description and locale tags carry `data-social-language="en"`; `site.js` respects this marker so switching the page display language does not overwrite English share metadata. A full marketing build is unnecessary.

## Deployment and verification

Use `node marketing/deploy-social-preview.cjs --apply`. The main-link English rollout backs up seven scoped files, checks baseline hashes, preserves page content and verifies public HTTP/HTTPS responses. The page comparison allows only social tags and the specific script cache-version change. Failure restores changed files. No database change, website restart or MT5 action is required. Main-link manifest: `marketing/social-preview-main-en-v4-deployment-result.json`. Earlier deployment manifests are retained separately.

The verifier checks initial HTML and image responses using ordinary, Facebook, X/Twitter and WhatsApp user-agent strings. It checks localized unique tags, canonical URLs, JPEG content type, real dimensions, approved source/public hashes and crawler-compatible compression. These are simulated checks; they do not publish on social platforms.

A future approved image needs a new versioned URL, source hash and dimensions/MIME metadata. Retain older assets. Never regenerate this selected image from a prompt. Concepts in `marketing/previews/` remain drafts, not the approved public asset.

## Cached previews

Share `https://corngrid.com/` or `https://corngrid.com/en/`. For a stale Facebook card, use [Sharing Debugger](https://developers.facebook.com/tools/debug/) and **Scrape Again** if available; a login may be required. Start a new draft after refreshing. Old posts do not automatically change. Threads and other apps control their own presentation and cache timing.

References: [Open Graph protocol](https://ogp.me/), [Meta: Images in Link Shares](https://developers.facebook.com/documentation/sharing/webmasters/images). The approved near-1.91:1 image keeps its original dimensions; those actual dimensions are declared in metadata.
