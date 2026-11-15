# Report layouts and exports

The user-supplied [BoxCompute screenshot](boxcompute-reference.png) is retained for composition reference. Inspect it when refining the visual system. Its statistics and product claims are unrelated to CornGrid; its social app controls are outside the report design.

| Report type (`report_type`) | Default template | Content emphasis |
|---|---|---|
| `daily-growth` | daily-growth.html | Daily registrations, activity and latest period |
| `weekly-saas` | weekly-report.html | Weekly acquisition, engagement and subscriptions |
| `monthly-business` | weekly-report.html | Monthly business totals and comparable prior month |
| `investor-progress` | investor-update.html | Executive summary, traction, verified milestone |
| `infrastructure` | weekly-report.html | Requests, nodes, capacity and measured service metrics |
| `sandbox-utilization` | weekly-report.html | Provisioned/active sandboxes and utilization definition |
| `mt5-infrastructure` | weekly-report.html | Connected accounts and infrastructure activity |
| `marketplace-performance` | weekly-report.html | Strategies, publishers and verified marketplace activity |
| `subscription-performance` | weekly-report.html | Paying subscribers, renewals and sourced revenue |
| `social-growth` | social-infographic.html | One achievement, short chart and compact KPIs |

All templates use shared components and brand CSS. `--template` can select a different supported template without changing report type or values. Templates contain `$name` slots consumed by Python `string.Template`, not standalone production reports. Generate an HTML file to preview.

## Components and content rules

- **Header**: original square CornGrid logo, report category, report date, small yellow update dot; sample mode prominently identifies synthetic data.
- **Hero/statistical highlight**: user-supplied factual headline, exact primary metric and label, optional secondary metric, and a short explanation. Growth is calculated from input, never copied from prose.
- **Chart**: dated daily/weekly/monthly bars or a line chart, labeled y-axis with unit and x-axis with dates. Latest period is yellow and labeled “latest”. Null points create gaps/N/A, never zero-height evidence. Comparison charts show previous/current values for a single consistent unit.
- **KPI grid**: one to six metrics. Use fewer when the source has fewer or the target canvas cannot accommodate long labels. Large figures on a charcoal panel, with short descriptive captions and optional comparison percentages.
- **Executive summary**: optional source-linked prose. Include a verified milestone or product update where supplied. Omit unsupported statements.
- **Footer**: short product update, CornGrid Infrastructure, corngrid.com, period, timezone, report date and source labels/as-of dates. No internal URLs, credentials, emails or account-level data in public copy.

## Target formats

| Format | Canvas / behavior |
|---|---|
| HTML | Self-contained, responsive, embedded logo/SVG, no network requests |
| PNG portrait | 1080 × 1350, default social infographic |
| PNG story | 1080 × 1920, more vertical space |
| PNG landscape | 1920 × 1080, wide presentation layout |
| PDF | A4 portrait, single report sheet; long material must be shortened or split deliberately |
| PPTX | Four 1920 × 1080 image-backed slides: overview, activity, KPIs, executive summary/source notes |

PNG/PDF/PPTX use an installed Chrome/Edge/Chromium in headless mode. `--browser /absolute/path/to/browser` overrides discovery. No browser flags disable its sandbox. Fixed exports run a clipping check and fail if material exceeds the canvas. Condense text or reduce KPI count instead of cropping. Output files are only replaced with `--force`. A `.audit.json` companion records the exact inputs and computed changes; treat that file according to the data's privacy level.

PPTX uses standard Office Open XML written by the standard library and embeds full-resolution rendered slides. This preserves fidelity across compatible viewers; it does not provide editable text or native PowerPoint charts. If editable slides are explicitly requested, use an available presentation authoring tool and verify the same data and logo invariants.
