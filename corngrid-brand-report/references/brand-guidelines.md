# CornGrid identity

Brand: **CornGrid**. Footer identity: **CornGrid Infrastructure**. Website: **corngrid.com**.

## Official asset and provenance

The user supplied the 1280 × 1280 JPEG `1000252013.jpg` with the BoxCompute screenshot during skill creation. `assets/corngrid-logo.original.jpg` is a byte-for-byte copy. `assets/corngrid-logo.png` is a lossless PNG encoding of its decoded pixels, including its yellow background and full original square. RGB pixels were compared and match exactly. The embedded ICC profile was preserved.

SHA-256:

- Original JPEG: `386da29f7f52ec2cf65eeaae2fa37c2f5b1f588cd9e3b2a2c0ab6c00e04f4ad4`
- Report PNG: `7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0`

Use the whole image with its 1:1 ratio, `object-fit: contain` and clear space of at least 12% of its displayed width outside the image. Scale proportionally only. Do not round or clip the image itself. A separate header label may say “CornGrid Infrastructure”; it must not replace or restyle the logo wordmark. If an official replacement is supplied, update the asset, hashes, measurements and generator constant together after verifying provenance. Never bypass the integrity check with an invented logo.

## Color tokens

| Token | Value | Usage |
|---|---|---|
| CornGrid yellow | `#FFEB00` | Highlight, indicator, latest chart period |
| Black | `#000000` | Headlines and primary text |
| White | `#FFFFFF` | Chart surface and light text |
| Warm off-white | `#F8F6EF` | Report paper |
| Dark charcoal | `#1B1B1B` | Statistical panel |
| Neutral gray | `#777777` | Nonessential lines and metadata on white |
| Accessible muted text | `#595959` | Small body text on warm paper |
| Light panel text | `#D9D8D1` | Supporting text on charcoal |

The most common yellow pixel in the **supplied** JPEG is RGB (255, 235, 1), or `#FFEB01` (356,633 pixels). This supports the requested `#FFEB00` accent. JPEG compression introduces variation; it is not evidence for recoloring the logo or a claim about a vector brand master. The earlier project JPEG is superseded by the user's attached asset.

## Typography, spacing and composition

Use Inter ExtraBold/800 for headlines, Inter Bold/700 for metrics and Inter Regular/400 for body. If Inter is unavailable locally, use Arial/Helvetica as the explicitly permitted equivalent. Do not depend on a remote font request. Metadata uses a system monospace stack.

Shared CSS tokens: 8px spacing rhythm, generous outer gutters, 20–28px panel radius, thin neutral separators, strong left alignment, tabular numbers. Bold metric figures carry hierarchy; captions explain the unit. Use yellow against charcoal or black against yellow; avoid yellow text on off-white. Gray/yellow chart marks require labels and a written latest-period marker so meaning never depends on color alone.

Composition follows the supplied BoxCompute report's editorial rhythm, adapted to CornGrid: small brand row, large factual headline, supporting highlight, concise context, pale chart card, dark six-metric panel, short product note and dated footer. Do not reproduce its orange accent, logo, mascot, copy, figures, social app chrome, screenshots or engagement counts. Avoid gradients, decorative 3D graphics, busy backgrounds and oversized dashboards full of unsupported metrics.

Responsive HTML uses at least 16px body text on phones. Fixed PNGs use prominent figures and short captions. Inspect PNGs at a phone-sized display; prefer fewer KPIs or the taller canvas when six labels become hard to read. Do not shrink an overflowing layout until it becomes illegible.
