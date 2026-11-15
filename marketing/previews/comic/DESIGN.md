# CornGrid comic link card — approval draft

Status: preview only, awaiting user approval. No live page, link-preview metadata or published image was changed.

Final draft: `corngrid-comic-preview-ms.png` (1200 × 630).

Direction: flat 2D comic book; warm off-white, CornGrid yellow and black; halftone dots, bold ink outlines, oversized headline and yellow comic caption. No 3D artwork. The whole official logo is composited at its original proportions after verifying its existing SHA-256. The illustration contains no financial statistics or performance claims.

Generation: built-in `image_gen.imagegen` tool for the blank 2D illustration. Typography and the official logo are composited deterministically by `render-preview.cjs` using the existing Sharp dependency. The original generated illustration is preserved locally as `background-original.png`.

Rebuild from the repository root: `node marketing/previews/comic/render-preview.cjs`.

## Imagegen prompt

Use case: ads-marketing. Create a FLAT 2D COMIC BOOK illustration background for a CornGrid website link-preview banner. Wide landscape aspect ratio exactly 1200:630. Palette only vivid yellow #FFEB00, ink black #111111, warm off-white #F8F6EF, with a tiny neutral grey if needed. This must look like an inked comic on paper: bold crisp hand-inked outlines, Ben-Day halftone dots, confident flat color blocks, a few dynamic comic action lines. NO 3D whatsoever, NO photorealism, NO glossy renders, NO gradients, no volumetric lighting, no dimensional bevels. Composition: the LEFT 60 percent is clean warm off-white negative space reserved for very large headline lettering that will be composited in code, so leave it blank and uncluttered. On the RIGHT 40 percent, draw a front-facing desktop computer monitor beside a small front-facing server cabinet in expressive 2D comic style, entirely flat and graphic, on a yellow irregular comic burst shape. The monitor has a plain solid black screen with absolutely no marks, symbols, graphs or text. The server cabinet uses simple vent lines. Use energetic black speed lines and subtle yellow/black halftone patterns behind the illustration. Keep header band (top 90px) and footer band (bottom 85px) mostly clear for a brand logo and website URL to be placed later. Black halftone dots may decorate the far corners, but keep the left headline area clean. Sophisticated, clear modern technology comic poster, strongly readable at small social card sizes. No characters or mascots. Absolutely NO typography, words, letters, numbers, brands, logos, watermarks, fake data, charts, profit curves, finance symbols, or coins. Illustration only; CornGrid's original official logo and exact large headline will be added separately. Do not depict a 3D perspective laptop; use a flat front-facing display and flat cabinet.

## Composited text

- CornGrid Infrastructure
- STRATEGI ANDA.
- KAMI URUS MT5.
- Sambung akaun. Pilih strategi.
- Urus sandbox MT5 anda.
- MT5 / SANDBOX
- corngrid.com

Approval applies to this draft composition. Publishing remains pending; a future deployment must use a new versioned image URL and retain the current v1 public assets.
