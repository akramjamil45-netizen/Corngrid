# CornGrid Infrastructure public website

Public pages are integrated into the existing IIS and Express application:

- `/`: Bahasa Melayu Infrastructure homepage.
- `/en/`: crawlable English homepage with its own canonical and hreflang links.
- `/corngrid-ea`: original EA page, with original marketing sections, assets,
  downloads, product metadata and translations. Navigation distinguishes the platform.
- `/login?mode=register`: opens the existing login form in registration mode.
- `/dashboard.html#subscription`, `#sandbox`, `#partner`: existing dashboard menus.

## Editing and rebuilding

Run `node marketing/build.js` from the project root after updating the template or
translations in `marketing/build.js`. It generates `index.html`, `en/index.html`,
`locales/ms.json`, `locales/en.json`, and the shared header in the preserved EA page.
The generated locale JSON files should not be edited independently of the builder.

The original support markup is maintained in **one source**:
`marketing/support.html`. The builder embeds it into both public pages. Original
support icons, links, positioning and animation styles remain in `mystyle.css`.
`site.js` handles the shared navigation/support behavior and language switching;
legacy EA interactions and translations remain in `script.js`.

Language preferences reuse `selectedLang` (`bm` / `en`) and default to BM.
An explicit `/en/` URL selects English. Storage access failures do not block rendering.
Both homepage languages contain full static HTML before JavaScript runs.

`infrastructure.css` scopes the new page styles to `.infra-page`; only shared header
adjustments and mobile navigation behavior apply to both public pages.

## Operational claims

- Pricing is available only through the authenticated subscription API. The public
  page links to actual plans and labels infrastructure-specific packages as upcoming.
- Sandbox setup uses the existing subscription activation allowance; each MT5
  account/strategy deployment consumes its existing license slot. Node capacity
  and physical resources also constrain placement. No public limit is invented.
- Sandbox separation is by terminal folder/process, not full VM or dedicated IP.
- Database credentials use AES-256-GCM, but authorized nodes need plaintext terminal
  startup details. The privacy information explains this limitation.
- Partner applications/submissions require administrator review. No guaranteed
  strategy certification or automatic commission payout is advertised.
- Dashboard samples are explicitly illustrative. No customer data is queried.
- Existing EA terms/risk documents remain linked as EA documents. The site does not
  fabricate a comprehensive privacy policy or infrastructure legal agreement.

## Verification

From `Corngrid-web`, run `node --test test/marketing.test.js` for public routes,
language dictionaries, EA sections, canonical URLs and non-interference with APIs.
Run the existing application test suite before deployment.

For a local public-only preview, run `node marketing/preview.js` from the root and
open `http://127.0.0.1:3108`. This preview has no backend APIs. Authentication and
dashboard operations must be verified on the existing application, not this preview.

Deployment uses the existing IIS root and the `CornGridWeb` Windows Service.
Restart that service after updating backend routing. No database migration is needed.
