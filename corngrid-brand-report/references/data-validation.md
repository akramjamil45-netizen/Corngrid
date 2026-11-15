# Data contract and validation

The generator accepts a UTF-8 JSON object. It never queries a database. Agents may prepare JSON from an authorized read-only export and must verify that its values match the source. Validation checks structural and arithmetic consistency, not the truth of the originating system.

## Input example

This is a schema illustration with **no asserted CornGrid metrics**. Replace nulls with verified values and source IDs when available. Keep `mode: production` only for real reporting; synthetic figures require `mode: sample` and remain visibly labeled.

```json
{
  "mode": "production",
  "report_type": "weekly-saas",
  "report_date": "2026-11-14",
  "period": {"start": "2026-11-07", "end": "2026-11-13"},
  "timezone": "Asia/Kuala_Lumpur",
  "comparison_period": {"start": "2026-10-31", "end": "2026-11-06"},
  "headline": "CornGrid weekly platform update",
  "context": "Reporting data is awaiting a verified export.",
  "hero_metric": "registered-users",
  "secondary_metric": "active-sandboxes",
  "metrics": [
    {"id": "registered-users", "label": "Registered users", "value": null, "previous": null, "unit": "count"},
    {"id": "active-sandboxes", "label": "Active sandboxes", "value": null, "unit": "count"}
  ],
  "chart": {
    "type": "bar", "title": "Daily activity", "unit": "count",
    "cadence": "daily", "points": []
  },
  "sources": [],
  "executive_summary": [],
  "product_update": "",
  "product_update_source": null
}
```

## Fields

Required: `mode` (`production` or `sample`), `report_type` (see layouts), `report_date` (ISO date), `period.start`, `period.end` (inclusive ISO dates), `timezone` (IANA name or explicit UTC offset label), `headline`, `metrics` (1–6) and `sources` (array, possibly empty when all data is missing).

Each metric requires a unique `id`, `label`, `value` (finite number or null) and `unit`: `count`, `number`, `percent`, `currency`, `ms`, `seconds` or `ratio`. `count` is a nonnegative integer. Currency requires a three-letter uppercase `currency`, such as USD or MYR; do not mix currencies. Numbers stay exact in audit files; display numbers are grouped, with up to two decimals. No automatic k/M abbreviations obscure exact values.

Optional metric `previous` has the same unit/definition as `value`. It needs a `comparison_period` and `previous_source` for a numeric value. Production numeric `value` requires `source`. Sources reference `sources[].id`.

Each source has `id`, a public-safe `label` and offset-aware ISO `as_of` timestamp. Production numerical claims require `as_of` no earlier than the reporting period end (for previous values, comparison end). Source timestamps must not be later than `report_date`. Exact extraction cutoff and reporting timezone must be verified by the agent before export; the script compares calendar dates and does not convert timestamps between timezones.

Optional source `locator` is retained only in the audit, never displayed in the report. Never include secrets. A supplied label such as “User-provided analytics export” is valid provenance when the user provides actual data; do not claim independent database verification.

Optional `chart` supports:

- `type`: `bar`, `line` or `comparison`.
- `title`, `unit`, `currency` (when applicable), `cadence`: `daily`, `weekly` or `monthly`.
- Bar/line: `points` is an ordered, unique date series, each `{"date":"2026-11-13","value":null,"source":null}`. Numeric production points need a valid source. Dates must lie inside the current reporting period; missing dates are allowed only as explicit null points. Cadence is checked (one day, seven days or adjacent calendar months). Maximum 31 points; aggregate a longer series explicitly and document the aggregation in context.
- Comparison: `metric_ids` selects existing metrics (all by default); every selected metric must share the chart unit and currency. Values and sources come from the KPI objects. Labels show previous/current periods. No invented historical series.

`hero_metric` defaults to the first KPI ID; `secondary_metric` is optional and must differ. Optional `context` is explanatory prose. `executive_summary` is up to four objects with `text` and `source`. In production, nonempty summary text and `product_update` require a source reference (`product_update_source` for the latter). Source references do not make prose true: verify each claim manually, especially headline, context, revenue and trading results. Keep copy concise; clipping is rejected for fixed formats.

## Arithmetic and reporting rules

- Percentage growth = `(current - previous) / previous * 100`, using decimal arithmetic. A zero, negative or missing baseline returns N/A, never infinity or an invented percentage. Percentage-valued KPI comparisons show percentage-point difference (`pp`) instead of relative growth.
- Compare equal-duration, nonoverlapping periods. Different-length **full adjacent calendar months** are allowed for monthly reports; label them honestly and assess seasonality. Unequal arbitrary windows are rejected. Do not compare partial weeks to complete weeks without adjusting the input to comparable windows.
- `report_date` must be at or after period end. Future comparisons, inverted dates, nonfinite numbers, duplicate KPI/source IDs, negative counts, unknown units and source references are rejected. Comparisons must precede the current period.
- Registered users, active users, active MT5 accounts, active sandboxes, subscribers, strategies and requests represent different entities; never substitute one for another. Define active windows, exclude test/deleted entities as appropriate, deduplicate identifiers and explain snapshots versus period flows.
- Revenue requires currency and an explicit definition (gross/net, recognized/collected, taxes/refunds). No invented MRR/ARR, paying customers, performance guarantees, trading returns or uptime claims. Distinguish infrastructure activity from investment results.
- No data → null/N/A or omit optional prose. Request essential data when the requested achievement cannot be supported. Never fabricate a chart series from a total.
- Sample mode is conspicuous in HTML, images, PDF, every PPTX slide and audit metadata. Production mode never falls back to sample values.
