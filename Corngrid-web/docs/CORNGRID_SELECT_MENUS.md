# CornGrid option menus

`public/corngrid-select.js` and `.css` provide one themed popup for single-choice
`select` controls in the user and admin dashboards, including controls created
later by Marketplace, reports, partner forms and sandbox setup. Mobile uses a
compact bottom panel; desktop positions the menu near its original field. The
existing dark/light theme variables determine colours, with gold selection states.

The original select remains in place. No wrapper, cloned form input, value setter
override, API request or framework is introduced. A changed selection sets its
original selected index and emits one bubbling `input` and `change`; reselecting
the same index and cancelling emit neither. Disabled controls/options/groups,
required validation, form reset and duplicate option values retain native semantics.
Option labels are inserted as text. Longer lists have local search. Arrow keys,
Home/End, typeahead, Enter/Space, Tab/Shift+Tab and Escape are supported, with focus
restored to the source control after closing. Nested form dialogs remain open.

Observers run while a menu is open, and are disconnected on close. A 150ms check
while open detects programmatic `.value`/`.selectedIndex` assignments that do not
produce DOM mutations. It does not poll a backend. Removed, hidden or disabled
source controls close the popup. Multi-selects and inline listboxes (`size > 1`)
stay native. Add `data-native-select` for an explicit opt-out. Browsers without
native dialog support retain the native picker; JavaScript failure also leaves
the original controls usable. OS date/file pickers and browser confirmation
dialogs are separate controls and are not replaced by this component.

Both dashboard HTML files load versioned assets. Root IIS `web.config` routes
`corngrid-select.css` and `.js` to the existing backend static server. The service
worker lists both as network-first static assets; API responses remain excluded.
No migration, new dependency, backend restart or agent update is needed.

## Interaction regression checks

1. Run `node marketing/preview-corngrid-select.cjs` from the repository root.
   It serves `/fixture` on a loopback ephemeral port, with no database access.
2. Navigate a Playwright page to the printed URL.
3. Run the Playwright browser tool with
   `filename: "Corngrid-web/test/browser/corngrid-select.browser.js"`.
   The assertions cover mouse/touch, keyboard, cancellation, event counts, focus,
   dynamic options, optgroups, disabled/required inputs, search, duplicates,
   safe labels, nested dialogs, dark/light themes and 320–1440px viewport bounds.
4. Stop the preview process after verification. Run the existing PWA, API-path
   and gateway tests as regression checks.

Browser touch emulation validates the shared web implementation; native Android
WebView/device and assistive-technology testing should also be performed on the
actual app release when available.
