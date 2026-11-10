# Public-page consent

The BM and English homepages load `cookie-consent.js` and `cookie-consent.css`. The source audit found no inline tracker, but the live site was receiving an automatically injected Cloudflare Web Analytics beacon. The homepage responses now include `Cache-Control: no-transform` to suppress automatic injection, and an inert manual beacon loads only after analytics consent. No advertising pixel was found; the unused advertising choice is disabled and no marketing consent is stored. Essential authentication/security and device language preferences remain functional. External fonts/icons and hosting/security request logs are disclosed separately in the notice; this banner does not block them.

Analytics and marketing start disabled. Choices are stored as versioned booleans and a timestamp in `cg_cookie_consent_v1` in first-party localStorage, for up to 180 days. Invalid, expired or missing records mean no optional consent. The notice is bilingual, offers equally prominent accept/reject controls, and can be reopened using the footer Cookie settings button. No visitor identifier or consent data is sent to a third party by this implementation.

## Adding optional tools

Never add normal, auto-running analytics/pixel tags to the page. Use one of these consent-controlled integrations:

```js
CornGridConsent.register({
  id: 'approved-analytics-provider',
  category: 'analytics', // or marketing
  enable() { /* load the approved tool only here */ },
  disable() { /* remove vendor listeners/timers and invoke its opt-out API */ }
});
```

Or mark a vendor script as inert:

```html
<script type="text/plain" data-cg-consent="analytics" data-src="https://approved-provider.example/analytics.js"></script>
```

Register after the consent script has loaded. Consent withdrawal invokes registered cleanup, removes common category-specific first-party tracking cookies and reloads to stop previously loaded scripts. Authentication cookies are never cleared. Third-party-domain cookies cannot be removed by this site. Add provider-specific cleanup for any additional local storage/cookies. Update the notice with the actual providers, purposes and retention before enabling a tool; increment the consent version when purposes materially change. Edge-injected tags (for example a Cloudflare-injected beacon) must also be configured to respect consent; a banner cannot intercept scripts injected outside this gate.

This implements preference controls, not a legal certification or a complete privacy policy. The operator must maintain accurate notices, provider settings and applicable legal requirements.

References reviewed: [ICO consent controls](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/), [Malaysia PDPA principles](https://www.pdp.gov.my/en/principles-of-personal-data-protection/).
