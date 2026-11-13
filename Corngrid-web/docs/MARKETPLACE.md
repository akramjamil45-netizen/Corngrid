# CornGrid EA Marketplace

Marketplace runs inside the existing dashboard. It adds advertisements and review
metadata; it reuses subscriptions, MT5 linking, the terminal, payments and sandbox
execution. Partner EA release review is integrated with listing publication; see
[PARTNER_PUBLICATION.md](PARTNER_PUBLICATION.md).

## Routes

| Audience | Existing dashboard route |
| --- | --- |
| Users | `/dashboard.html#marketplace` |
| EA details | `/dashboard.html#marketplace/<listing-id>` |
| Approved partners | `/dashboard.html#partner-marketplace` |
| Administrator | `/admin.html#marketplace` |

These use the project's existing hash routing and mobile sidebar. Direct links,
browser back, PWA and the Android Capacitor remote website use the same pages.
Admin navigation stays available while the feature is OFF.

## Installation and first use

1. Install the locked Node dependencies (`npm ci` for a fresh installation).
   The new runtime dependency is Sharp 0.35.5 for image decoding and re-encoding.
   Existing Windows installations can add the exact Sharp dependency before
   copying the updated package manifests, without rebuilding existing native modules.
2. Apply `migrations/postgres/0015_marketplace.sql` and `0016_partner_publication.sql` with the existing migration
   process before starting the updated backend. SQLite self-applies its equivalent.
3. Deploy the changed backend and dashboard assets. Add the four Marketplace
   asset names to both IIS proxy configurations. Deploy the updated root `sw.js`.
4. Restart **CornGridWeb only**. The optional source compile workflow also needs
   the updated test-node agent files described in PARTNER_PUBLICATION.md. Running
   hosting agents and MT5 terminals do not need to be restarted.
5. Open **Admin → Marketplace**. Installation creates an editable **draft** of
   CornGrid Official EA linked to the existing `corngrid-ea` strategy. Add the
   description, version, instruments, timeframes and trading risks; upload media.
6. Explicitly publish the listing. Set infrastructure availability separately.
   `Available` requires a published, active, provider-matched operational strategy,
   an existing `.ex5` artifact inside strategy storage, and approved presets for at
   least one listed symbol. The existing executable approval workflow remains required.
7. Configure featured placements and the optional promotional banner/destination.
8. Turn **Marketplace Enabled** ON when ready. No server restart is needed.

Default is **OFF**. Global OFF blocks user and partner Marketplace APIs, hides
their Marketplace menus, and overrides individual allow rules. Administrative
management remains available. Settings/menu polling refreshes every 30 seconds,
on window focus and when entering Marketplace; APIs enforce changes immediately.
Per-user controls support default/allow/block without changing other account roles.

No new environment variables, Stripe configuration or broker credentials are needed.
Media defaults to the private `Corngrid-web/storage/marketplace-media` directory.
Include it, the database, and existing strategy storage in regular backups.

## Permissions and approval

- User JWT/cookie authentication and verified/archived/suspended account checks
  reuse `user-auth.js`. Admin JWT/version and cookie CSRF checks reuse `admin-auth.js`.
- Partner permissions reuse active `partner_profiles`, the result of the existing
  partner application approval process. A request body cannot select a provider,
  owner, role, official status, deployment approval or featured placement.
- Partners own only their own partner listings. They cannot modify official EAs,
  link executable strategies, approve/publish listings, change availability, or
  control promotions/settings/access.
- Partner text, logo and screenshot changes return the advertisement to **draft**.
  This also applies when an administrator edits partner advertisement content.
  The partner submits the new revision for review again. Operational EAs continue.
- Submission stores a full metadata/media-hash snapshot. Editing a pending
  revision supersedes its pending review. Approve/reject operations check the
  locked listing and exact revision; old approvals cannot publish new revisions.
- Partner submission requires an EA executable/source project and a `.set` for
  every supported pair. **Approve & publish** atomically publishes the exact
  reviewed EX5, presets, operational strategy and Marketplace listing. Metadata
  alone cannot be approved. A source-only submission first needs a compiled EX5.
  Unpublishing and republishing an unchanged approved release retains its
  approval. Archive removes the advertisement, without removing operational EAs.
- Official advertisements are managed only through admin authentication.
- Content writes use optimistic revision checks. Review/publication/media changes
  run in transactions with PostgreSQL row locks or the shared SQLite write queue.
  Administrative actions are recorded in `marketplace_audit` in the same transaction.

## Infrastructure handoff

Listings reference `trading_strategies.id`, rather than copying operational
configuration. Partner strategy references must belong to the listing's partner;
official references cannot point to a partner's strategy.

`POST /api/marketplace/eas/:id/deployment` rechecks feature/user access, publication,
availability, strategy ownership/publication/artifact/presets, existing subscription
eligibility and sandbox allowance. It returns the real strategy code and supported
symbols for the existing sandbox form. It does not create a terminal, activation
or simulated connection. The existing `/api/sandbox/activate` remains authoritative
for account ownership, credentials, activation reuse/quota and physical node capacity.

Changing an advertisement, Marketplace availability, publication or feature flags
never updates a running terminal, a strategy's executable publication, or a license.
Operational strategy availability continues to be administered in the existing
EA workflow. Marketplace availability controls the Marketplace handoff only.

## API

All endpoints require the appropriate existing session. User settings return only
effective access, partner navigation eligibility, categories and a visible promotion.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/marketplace/settings` | Effective feature access and promotion |
| GET | `/api/marketplace/eas` | Published listings, search, provider/strategy filters, pagination |
| GET | `/api/marketplace/eas/:id` | Published detail, gallery and actual handoff capability |
| POST | `/api/marketplace/eas/:id/deployment` | Authorized handoff to existing sandbox form |
| GET | `/api/marketplace/media/:imageId` | Authorized published image/banner |
| GET, POST | `/api/partner/marketplace/eas` | Own listing list / create draft |
| GET, PATCH | `/api/partner/marketplace/eas/:id` | Own preview / edit metadata |
| POST | `/api/partner/marketplace/eas/:id/submit` | Submit revision, EA files, presets and retry request key |
| POST | `/api/partner/marketplace/eas/:id/logo` | Replace logo |
| POST | `/api/partner/marketplace/eas/:id/screenshots` | Append screenshot |
| POST | `/api/partner/marketplace/eas/:id/screenshots/order` | Reorder all current screenshot IDs |
| DELETE | `/api/partner/marketplace/eas/:id/screenshots/:imageId` | Remove screenshot or custom logo |
| GET | `/api/partner/marketplace/media/:imageId` | Own unpublished media |
| GET, PATCH | `/api/admin/marketplace/settings` | Global feature and promotion configuration |
| GET, POST | `/api/admin/marketplace/eas` | All listings / create official draft |
| GET, PATCH | `/api/admin/marketplace/eas/:id` | Detail/review history / edit metadata |
| POST | `/api/admin/marketplace/eas/:id/approve` or `/reject` | Approve & publish exact release digest / reject with reason |
| PATCH | `/api/admin/marketplace/eas/:id/publication` | Publish, unpublish, archive or reopen |
| PATCH | `/api/admin/marketplace/eas/:id/infrastructure` | Marketplace availability |
| PATCH | `/api/admin/marketplace/eas/:id/featured` | Featured placement |
| GET | `/api/admin/marketplace/strategies` | Existing operational strategy references |
| GET | `/api/admin/marketplace/access?search=...` | Find users and their overrides |
| PATCH | `/api/admin/marketplace/access/:userId` | `enabled: true`, `false`, or `null` for default |
| GET | `/api/admin/marketplace/audit` | Recent administrative/partner actions |
| POST | `/api/admin/marketplace/promotion/image` | Upload banner image |

Admin has matching logo/screenshot/order/delete/media endpoints under
`/api/admin/marketplace/...`, for any listing. Metadata and state actions take the
current integer `revision`; conflict returns 409. Approve also requires the current
`reviewDigest` returned by management detail. Reject also requires `reason`.
Listing queries support `search`, `provider=official|partner`, strategy category,
`page`; management also supports publication `status`. Pages contain at most 24
listings. Limits are imposed on mutation, upload and browse request rates.

## Images and formatted descriptions

Send **one file** per request as `application/octet-stream`, maximum 4 MB. The UI
supports choosing several images, previews them locally, and uploads sequentially.
Up to 10 screenshots per listing are enforced under a database lock. Native gallery
dialogs provide a visible Close control, previous/next, arrow keys and mobile swipe.

Only static JPEG/PNG/WebP images are accepted. The backend limits input to 20 million
pixels, rejects animated/unsupported/corrupt files, decodes and re-encodes to WebP,
strips input metadata and bounds output to 512px logos, 1920px screenshots or 1600px
banners. UUID filenames are generated on the server. Files live outside public
and are served only after publication/feature/ownership checks, with nosniff and
private no-store responses. Removed files remain privately retained for review
history; they cannot be fetched through published/partner media routes. Add a
retention policy before automated purging of review evidence.

Descriptions have named text sections (overview, features, strategy, markets,
configuration, risk management, risks, changelog). The renderer escapes all input
before supporting line breaks, `-` bullets and `**bold**`. It never interprets user
HTML, JavaScript, frames or arbitrary media URLs.

Sharp references used for implementation: [constructor options](https://sharp.pixelplumbing.com/api-constructor/),
[input metadata](https://sharp.pixelplumbing.com/api-input/),
[output metadata and WebP](https://sharp.pixelplumbing.com/api-output/).

## Verification

```powershell
cd Corngrid-web
node --test 'test/*.test.js'
```

`test/marketplace.test.js` uses real authentication/CSRF middleware and an isolated
in-memory database. It covers default OFF, toggles and overrides, partner ownership,
official exclusivity, stale/concurrent edits/reviews, reviewed release publication,
search/pagination, safe media/order/delete/limits, draft media visibility, audit
rollback, archived accounts, existing MT5/subscription APIs and entitlement handoff.

`marketing/verify-marketplace-postgres.cjs` tests two independent pools in a random,
temporary PostgreSQL schema, including concurrent metadata/media/submission/review
operations. It never mutates production tables or runs an EA.
`marketing/preview-marketplace.cjs` runs the real dashboard/admin UI against an
isolated API/database for responsive browser testing. Fixture artifacts are never
executed. No production preview data or example profitability is seeded.

## Rollback

Turn Marketplace OFF first. Restore the backed-up backend/frontend/IIS/service
worker/package files and restart CornGridWeb. The additive tables can remain.
Only if Marketplace metadata is deliberately being discarded, back it up and
apply `migrations/rollback/0015_marketplace.sql` **after** restoring the old code.
Migration 0016 references Marketplace review records: retain these tables and
their files for audit, or explicitly back up and remove 0016 first using its
rollback script. The optional 0015 script drops only Marketplace tables. It preserves users, partner
profiles, strategies, subscriptions, payments and sandbox instances. Do not delete
media while any retained review or backup still requires it.
