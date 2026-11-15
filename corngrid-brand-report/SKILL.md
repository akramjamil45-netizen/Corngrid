---
name: corngrid-brand-report
description: Create CornGrid Infrastructure branded reports, investor updates, SaaS analytics and social infographics from verified statistics. Use for CornGrid daily, weekly, monthly, infrastructure, sandbox, MT5, marketplace, subscription and social growth reporting, with HTML, PNG, A4 PDF or PPTX exports.
---

# CornGrid Brand Report

Generate finished, factual CornGrid reports with the original logo, editorial hierarchy, simple charts and a black-and-yellow statistical panel. Apply automatically when the user requests a CornGrid branded report or infographic. Do not change application functionality or production data.

## Workflow

1. Identify report type, audience, reporting period, timezone and export format. Default social posts to 1080 × 1350 and business reports to responsive HTML when no format is specified.
2. Collect user-supplied statistics or retrieve them from sources the user has authorized. Prefer read-only exports. Never infer permission to access a database, expose credentials or publish/send a report.
3. Read [data-validation.md](references/data-validation.md). Verify definitions, source freshness, dates, units, deduplication and comparison periods. Prepare the documented JSON input; numeric values require source references. Missing values are `null`, rendered as N/A. Do not turn missing data into zero.
4. Read [report-layouts.md](references/report-layouts.md) to select a template and output size. Use the supplied BoxCompute reference only for composition: warm paper background, two-level headline, restrained activity chart, dark KPI panel and compact footer. Never copy its figures or product claims into CornGrid reports.
5. Follow [brand-guidelines.md](references/brand-guidelines.md). Use `assets/corngrid-logo.png` exactly as supplied. The original JPEG is retained for provenance. Never redraw, crop, recolor, distort, remove its background or replace it with generated artwork. If missing or corrupt, request the original file and stop branded rendering.
6. Write a concise headline around a verified metric. Select the primary metric using `hero_metric`; use `secondary_metric` for its supporting highlight. Only add narrative statements and product updates supported by supplied material. The generator calculates numerical highlights and changes; an agent must verify any prose claims.
7. Run `scripts/generate-report.py` with the JSON input. Reusable header, KPI, bar/line/comparison chart, date, summary and footer functions live in that module; shared design tokens live in `templates/report.css`.
8. Inspect the rendered output: logo fidelity, alignment, legibility on mobile, spelling, chart axes, exact KPI values, source coverage, reporting period and sample labels. Fixed-size exports reject detectable clipping; this does not replace visual review.
9. Export the requested format and return a link to the finished file, reporting period and material data gaps. Do not present sample reports as production results.

## Generator

Requires Python 3.10+; uses only the standard library. HTML has no runtime dependencies and works offline. PNG/PDF/PPTX require an installed Chromium, Chrome or Edge browser, discovered automatically or provided with `--browser`. The script never downloads dependencies or accesses a database.

```bash
python scripts/generate-report.py --input statistics.json --format html --output report.html
python scripts/generate-report.py --input statistics.json --format png --size 1080x1350 --output report.png
python scripts/generate-report.py --input statistics.json --format png --size 1080x1920 --output story.png
python scripts/generate-report.py --input statistics.json --format png --size 1920x1080 --output landscape.png
python scripts/generate-report.py --input statistics.json --format pdf --output report.pdf
python scripts/generate-report.py --input statistics.json --format pptx --output investor-update.pptx
python scripts/generate-report.py --input statistics.json --validate-only
```

Paths above are relative to this skill directory. They also work from elsewhere with absolute paths. Add `--force` only to replace an existing output intentionally. `--sample` generates a visibly labeled demonstration using synthetic data; it cannot relabel production input as sample or sample input as production. Do not use its figures as CornGrid facts.

```bash
python scripts/generate-report.py --sample --format html --output sample.html
python scripts/generate-report.py --sample --format pptx --output sample.pptx
```

See `examples/production-input.json` for an empty production input to populate, and `examples/sample-portrait.png` for the reference composition with clearly labeled synthetic figures. For maintenance, run `python scripts/test_generate_report.py`; `python scripts/verify_exports.py --output-dir /path/to/checks` exercises all export formats using sample data only.

Each output gets a `.audit.json` companion containing exact values, source metadata, comparison calculations, input and logo hashes, and mode. Keep private source locators out of public reports; obtain an approved public-safe export first. PPTX contains four image-backed 16:9 slides for visual consistency; text is selectable in HTML/PDF, but slides are not editable chart objects.

## Portability and discovery

Keep this entire folder together. Install it in the compatible agent's skill directory (for Codex, `$CODEX_HOME/skills/corngrid-brand-report`, normally `~/.codex/skills/corngrid-brand-report`). No machine-specific paths or credentials belong in the skill. `agents/openai.yaml` allows implicit invocation; other agents use the SKILL.md frontmatter and their own discovery mechanism. Installing does not authorize data access, distribution or production changes.
