#!/usr/bin/env python3
"""Offline CornGrid report generation. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
import base64
import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
from string import Template
import tempfile
import zipfile
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parent.parent
LOGO_HASH = "7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0"
REPORTS = {
    "daily-growth": ("Daily Growth Update", "daily-growth"),
    "weekly-saas": ("Weekly SaaS Performance", "weekly-report"),
    "monthly-business": ("Monthly Business Report", "weekly-report"),
    "investor-progress": ("Investor Progress Update", "investor-update"),
    "infrastructure": ("CornGrid Infrastructure Report", "weekly-report"),
    "sandbox-utilization": ("Sandbox Utilization Report", "weekly-report"),
    "mt5-infrastructure": ("MT5 Trading Infrastructure Report", "weekly-report"),
    "marketplace-performance": ("Marketplace Performance Report", "weekly-report"),
    "subscription-performance": ("Subscription Performance Report", "weekly-report"),
    "social-growth": ("Social Media Growth Infographic", "social-infographic"),
}
UNITS = {"count", "number", "percent", "currency", "ms", "seconds", "ratio"}
SIZES = {"1080x1350": (1080, 1350, "portrait"),
         "1080x1920": (1080, 1920, "story"),
         "1920x1080": (1920, 1080, "landscape")}


class ReportError(ValueError):
    """Actionable input or export failure."""


def require(condition, message):
    if not condition:
        raise ReportError(message)


def text(value, name, limit=300, empty=False):
    require(isinstance(value, str), f"{name} must be text.")
    require((empty or bool(value.strip())) and len(value) <= limit,
            f"{name} must contain {'0' if empty else '1'}–{limit} characters.")
    return value


def iso_date(value, name):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value),
            f"{name} must be an ISO date (YYYY-MM-DD).")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ReportError(f"Invalid {name}: {value}.") from exc


def period(value, name):
    require(isinstance(value, dict), f"{name} must contain start and end.")
    start = iso_date(value.get("start"), f"{name}.start")
    end = iso_date(value.get("end"), f"{name}.end")
    require(start <= end, f"{name}.start must not follow end.")
    return start, end


def number(value, name, unit="number"):
    if value is None:
        return None
    require(isinstance(value, (int, float, Decimal)) and not isinstance(value, bool),
            f"{name} must be a number or null, not a formatted string.")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ReportError(f"Invalid number: {name}.") from exc
    require(result.is_finite(), f"{name} must be finite.")
    require(abs(result) < Decimal("1e18"), f"{name} exceeds the supported display range.")
    if unit == "count":
        require(result >= 0 and result == result.to_integral_value(),
                f"{name} must be a nonnegative integer count.")
    if unit in {"ms", "seconds", "ratio"}:
        require(result >= 0, f"{name} must be nonnegative for {unit}.")
    return result


def full_month(start, end):
    return start.day == 1 and end == date(start.year, start.month,
                                        calendar.monthrange(start.year, start.month)[1])


def validate(data):
    require(isinstance(data, dict), "Input must be a JSON object.")
    require(data.get("mode") in {"sample", "production"}, "mode must be sample or production.")
    require(data.get("report_type") in REPORTS, "Unsupported report_type; see report-layouts.md.")
    report_day = iso_date(data.get("report_date"), "report_date")
    start, end = period(data.get("period"), "period")
    require(end <= report_day, "Reporting period cannot end after report_date.")
    tz = text(data.get("timezone"), "timezone", 60)
    require(bool(re.fullmatch(r"(?:[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)+|UTC(?:[+-](?:0\d|1[0-4]):[0-5]\d)?)", tz)),
            "timezone must be an IANA name or UTC offset label, such as Asia/Kuala_Lumpur or UTC+08:00.")
    text(data.get("headline"), "headline", 100)
    text(data.get("context", ""), "context", 240, empty=True)
    compare = None
    if data.get("comparison_period") is not None:
        compare = period(data["comparison_period"], "comparison_period")
        cs, ce = compare
        require(ce < start, "Comparison period must precede the current period without overlap.")
        monthly = (data["report_type"] == "monthly-business" and full_month(start, end)
                   and full_month(cs, ce) and ce + timedelta(days=1) == start)
        require(end - start == ce - cs or monthly,
                "Compare equal-duration windows or adjacent full months for monthly-business.")
    sources = data.get("sources")
    require(isinstance(sources, list) and len(sources) <= 8, "sources must be an array of up to 8 entries.")
    source_dates = {}
    for source in sources:
        require(isinstance(source, dict), "Each source must be an object.")
        sid = text(source.get("id"), "source.id", 60)
        require(sid not in source_dates, f"Duplicate source ID: {sid}.")
        text(source.get("label"), "source.label", 90)
        stamp = text(source.get("as_of"), "source.as_of", 40)
        try:
            as_of = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ReportError(f"Invalid as_of for {sid}.") from exc
        require(as_of.tzinfo is not None and as_of.utcoffset() is not None,
                f"Source {sid} as_of requires an explicit UTC offset.")
        require(as_of.date() <= report_day, f"Source {sid} is dated after report_date.")
        source_dates[sid] = as_of.date()

    def source_check(sid, name, cutoff=None):
        require(isinstance(sid, str) and sid in source_dates, f"{name} needs a valid source ID.")
        if cutoff is not None and data["mode"] == "production":
            require(source_dates[sid] >= cutoff, f"{name} source predates its reporting period end.")

    metrics = data.get("metrics")
    require(isinstance(metrics, list) and 1 <= len(metrics) <= 6, "Provide 1–6 metrics.")
    metric_map = {}
    for metric in metrics:
        require(isinstance(metric, dict), "Each metric must be an object.")
        mid = text(metric.get("id"), "metric.id", 60)
        require(mid not in metric_map, f"Duplicate metric ID: {mid}.")
        metric_map[mid] = metric
        text(metric.get("label"), f"{mid}.label", 46)
        unit = metric.get("unit")
        require(unit in UNITS, f"Unsupported unit for {mid}.")
        if unit == "currency":
            require(bool(re.fullmatch(r"[A-Z]{3}", str(metric.get("currency", "")))),
                    f"{mid} needs a three-letter currency code.")
        require("value" in metric, f"{mid}.value is required; use null when missing.")
        current = number(metric["value"], f"{mid}.value", unit)
        previous = number(metric.get("previous"), f"{mid}.previous", unit)
        require("growth" not in metric and "growth_percent" not in metric,
                f"{mid}: supply current/previous, not an asserted growth percentage.")
        if current is not None and data["mode"] == "production":
            source_check(metric.get("source"), mid, end)
        elif metric.get("source") is not None:
            source_check(metric["source"], mid)
        if previous is not None:
            require(compare is not None, f"{mid}.previous needs comparison_period.")
            if data["mode"] == "production":
                source_check(metric.get("previous_source"), f"{mid}.previous", compare[1])
            elif metric.get("previous_source") is not None:
                source_check(metric["previous_source"], f"{mid}.previous")
    primary = data.get("hero_metric", metrics[0]["id"])
    require(primary in metric_map, "hero_metric must reference a metric ID.")
    secondary = data.get("secondary_metric")
    if secondary is not None:
        require(secondary in metric_map and secondary != primary,
                "secondary_metric must reference a different metric ID.")
    summary = data.get("executive_summary", [])
    require(isinstance(summary, list) and len(summary) <= 4, "executive_summary must have up to 4 items.")
    for item in summary:
        require(isinstance(item, dict), "Summary entries need text and source.")
        text(item.get("text"), "executive_summary.text", 200)
        if data["mode"] == "production" or item.get("source") is not None:
            source_check(item.get("source"), "executive summary")
    update = text(data.get("product_update", ""), "product_update", 160, empty=True)
    if update and (data["mode"] == "production" or data.get("product_update_source") is not None):
        source_check(data.get("product_update_source"), "product update")
    chart = data.get("chart")
    if chart is not None:
        require(isinstance(chart, dict), "chart must be an object.")
        require(chart.get("type") in {"bar", "line", "comparison"}, "chart.type must be bar, line or comparison.")
        text(chart.get("title"), "chart.title", 70)
        require(chart.get("unit") in UNITS, "chart.unit is invalid.")
        if chart["unit"] == "currency":
            require(bool(re.fullmatch(r"[A-Z]{3}", str(chart.get("currency", "")))),
                    "Currency chart needs a currency code.")
        if chart["type"] == "comparison":
            mids = chart.get("metric_ids", list(metric_map))
            require(isinstance(mids, list) and 1 <= len(mids) <= 6 and len(set(mids)) == len(mids),
                    "Comparison chart needs 1–6 unique metric IDs.")
            require(compare is not None, "Comparison chart needs comparison_period.")
            for mid in mids:
                require(mid in metric_map, f"Unknown comparison metric: {mid}.")
                metric = metric_map[mid]
                require(metric["unit"] == chart["unit"] and metric.get("currency") == chart.get("currency"),
                        "Comparison charts cannot mix units or currencies.")
        else:
            cadence = chart.get("cadence", "daily")
            require(cadence in {"daily", "weekly", "monthly"}, "Invalid chart cadence.")
            points = chart.get("points", [])
            require(isinstance(points, list) and len(points) <= 31, "Chart supports up to 31 points.")
            last = None
            for point in points:
                require(isinstance(point, dict) and "value" in point, "Points need date and value (or null).")
                current_date = iso_date(point.get("date"), "point.date")
                require(start <= current_date <= end, "Chart dates must lie inside the current period.")
                if last is not None:
                    require(current_date > last, "Chart dates must be unique and increasing.")
                    if cadence in {"daily", "weekly"}:
                        require((current_date - last).days == (1 if cadence == "daily" else 7),
                                "Chart date gaps require explicit null points; check cadence.")
                    else:
                        require(current_date.year * 12 + current_date.month == last.year * 12 + last.month + 1,
                                "Monthly chart requires adjacent months; include null points for gaps.")
                last = current_date
                val = number(point["value"], "chart point", chart["unit"])
                if val is not None and data["mode"] == "production":
                    source_check(point.get("source"), "chart point", end)
                elif point.get("source") is not None:
                    source_check(point["source"], "chart point")
    return data


def display(value, unit="number", currency=None):
    if value is None:
        return "N/A"
    val = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if val == 0:
        val = abs(val)
    out = f"{val:,.2f}".rstrip("0").rstrip(".")
    if unit == "percent":
        return out + "%"
    if unit == "currency":
        return f"{currency} {out}"
    if unit == "ms":
        return out + " ms"
    if unit == "seconds":
        return out + " s"
    if unit == "ratio":
        return out + "×"
    return out


def change(metric):
    current, previous = metric.get("value"), metric.get("previous")
    if current is None or previous is None:
        return None
    current, previous = Decimal(str(current)), Decimal(str(previous))
    if metric["unit"] == "percent":
        return current - previous
    if previous <= 0:
        return None
    return (current - previous) / previous * 100


def change_label(metric):
    result = change(metric)
    if result is None:
        return "Change N/A"
    suffix = " pp" if metric["unit"] == "percent" else "%"
    sign = "+" if result > 0 else ""
    return f"{sign}{display(result)}{suffix} vs prior period"


def esc(value):
    return html.escape(str(value), quote=True)


def logo_bytes():
    path = ROOT / "assets" / "corngrid-logo.png"
    require(path.is_file(), "Official logo missing. Request the user's original logo; do not recreate it.")
    content = path.read_bytes()
    require(hashlib.sha256(content).hexdigest() == LOGO_HASH,
            "Official logo integrity check failed. Restore the original asset or verify an official replacement.")
    return content


def brand_header(data, logo):
    category = REPORTS[data["report_type"]][0]
    sample = '<span class="sample">SAMPLE · SYNTHETIC DATA</span>' if data["mode"] == "sample" else ""
    return (f'<header class="brand-header"><div class="brand-lockup"><img class="brand-logo" '
            f'src="data:image/png;base64,{base64.b64encode(logo).decode()}" alt="Official CornGrid logo" '
            'width="88" height="88"><div><div class="brand-name">CornGrid</div>'
            f'<div class="eyebrow">Infrastructure</div></div></div><div class="date">'
            f'<span class="update-indicator" aria-hidden="true"></span>{esc(category)}<br>'
            f'{esc(data["report_date"])}{sample}</div></header>')


def statistical_highlight(data):
    metrics = {m["id"]: m for m in data["metrics"]}
    primary = metrics[data.get("hero_metric", data["metrics"][0]["id"])]
    out = (f'<h1>{esc(data["headline"])}</h1><div class="hero-values">'
           f'<span class="hero-stat">{esc(display(primary["value"], primary["unit"], primary.get("currency")))}</span>'
           f'<span class="hero-label">{esc(primary["label"])}</span></div>')
    if data.get("secondary_metric"):
        second = metrics[data["secondary_metric"]]
        out += (f'<p class="supporting"><span class="highlight">'
                f'{esc(display(second["value"], second["unit"], second.get("currency")))} '
                f'{esc(second["label"])}</span></p>')
    if data.get("context"):
        out += f'<p class="context">{esc(data["context"])}</p>'
    return out


def kpi_cards(data):
    cards = []
    for metric in data["metrics"]:
        delta = f'<div class="kpi-change">{esc(change_label(metric))}</div>' if "previous" in metric else ""
        cards.append(f'<div class="kpi"><div class="kpi-value">'
                     f'{esc(display(metric["value"], metric["unit"], metric.get("currency")))}</div>'
                     f'<div class="kpi-label">{esc(metric["label"])}</div>{delta}</div>')
    return '<section class="metrics-panel" aria-label="Key performance indicators"><div class="metrics-grid">' + "".join(cards) + '</div></section>'


def svg_chart(chart, data):
    comparison = chart["type"] == "comparison"
    metric_map = {m["id"]: m for m in data["metrics"]}
    if comparison:
        metrics = [metric_map[mid] for mid in chart.get("metric_ids", list(metric_map))]
        labels = [m["label"] for m in metrics]
        series = [[m.get("previous"), m["value"]] for m in metrics]
    else:
        points = chart.get("points", [])
        labels = [date.fromisoformat(p["date"]).strftime("%d %b") for p in points]
        series = [[p["value"]] for p in points]
    flat = [Decimal(str(val)) for group in series for val in group if val is not None]
    if not flat:
        return '<div class="chart-empty">N/A · No verified activity series supplied</div>'
    ymin, ymax = min(Decimal(0), min(flat)), max(Decimal(0), max(flat))
    if ymin == ymax:
        ymax = ymin + 1
    # Zero baseline, shared scale, no smoothing or interpolation through null points.
    left, top, width, height = 90, 24, 780, 170
    def ypos(val):
        return top + float((ymax - Decimal(str(val))) / (ymax - ymin)) * height
    baseline = ypos(0)
    elems = [f'<svg class="chart-svg" role="img" aria-labelledby="chart-title chart-desc" viewBox="0 0 900 270" xmlns="http://www.w3.org/2000/svg">',
             f'<title id="chart-title">{esc(chart["title"])}</title>',
             '<desc id="chart-desc">Labeled chart with a zero baseline. Latest period is marked in yellow. Missing values are N/A.</desc>']
    for tick in range(4):
        value = ymin + (ymax - ymin) * Decimal(tick) / 3
        y = ypos(value)
        elems.append(f'<line x1="{left}" y1="{y:.2f}" x2="{left+width}" y2="{y:.2f}" stroke="#e5e3dc"/>')
        elems.append(f'<text class="tick-label" x="{left-10}" y="{y+6:.2f}" text-anchor="end" fill="#595959" font-size="20">{esc(display(value))}</text>')
    slot = width / len(series)
    path = []
    label_every = max(1, math.ceil(len(series) / 7))
    for i, values in enumerate(series):
        center = left + slot * (i + .5)
        last = i == len(series) - 1
        if i % label_every == 0 or last:
            label = labels[i]
            if len(label) > 22:
                label = label[:21] + "…"
            mobile_class = " mobile-keep" if i in {0, len(series)//2, len(series)-1} else ""
            elems.append(f'<text class="x-label{mobile_class}" x="{center:.2f}" y="224" text-anchor="middle" fill="#1B1B1B" font-size="19">{esc(label)}</text>')
        for j, val in enumerate(values):
            color = ("#FFEB00" if j == 1 else "#777777") if comparison else ("#FFEB00" if last else ("#1B1B1B" if i % 3 == 0 else "#99978f"))
            x = center + (j - .5) * slot * .34 if comparison else center
            if val is None:
                elems.append(f'<text x="{x:.2f}" y="{top+height/2:.2f}" text-anchor="middle" fill="#595959" font-size="18">N/A</text>')
                if path:
                    elems.append(f'<polyline points="{" ".join(path)}" fill="none" stroke="#1B1B1B" stroke-width="3"/>')
                    path = []
                continue
            y = ypos(val)
            if chart["type"] == "line":
                path.append(f"{x:.2f},{y:.2f}")
                elems.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="6" fill="{color}" stroke="#1B1B1B"/>')
            else:
                bar_width = slot * (.28 if comparison else .72)
                elems.append(f'<rect x="{x-bar_width/2:.2f}" y="{min(y,baseline):.2f}" width="{bar_width:.2f}" height="{abs(y-baseline):.2f}" rx="5" fill="{color}" stroke="{"#8d8200" if color == "#FFEB00" else color}"/>')
            if (last or len(series) <= 7) and len(str(val)) < 12:
                latest_class = " latest-value" if last else ""
                elems.append(f'<text class="value-label{latest_class}" x="{x:.2f}" y="{max(18,y-9):.2f}" text-anchor="middle" font-size="21" font-weight="700" fill="#000000">{esc(display(val))}</text>')
        if last and not comparison:
            elems.append(f'<text class="latest-label" x="{center:.2f}" y="251" text-anchor="middle" font-size="18" font-weight="700">latest</text>')
    if path:
        elems.append(f'<polyline points="{" ".join(path)}" fill="none" stroke="#1B1B1B" stroke-width="3"/>')
    elems.append('</svg>')
    return "".join(elems)


def growth_bar_chart(data):
    chart = data.get("chart")
    if chart is None:
        return ""
    currency = chart.get("currency")
    unit = currency if chart["unit"] == "currency" else chart["unit"]
    rows = []
    if chart["type"] == "comparison":
        caption = f'Gray: {data["comparison_period"]["start"]}–{data["comparison_period"]["end"]} · Yellow: {data["period"]["start"]}–{data["period"]["end"]}'
        for metric in data["metrics"]:
            if metric["id"] in chart.get("metric_ids", [m["id"] for m in data["metrics"]]):
                rows.append(f'<tr><th scope="row">{esc(metric["label"])}</th><td>{esc(display(metric.get("previous"), chart["unit"], currency))}</td><td>{esc(display(metric["value"], chart["unit"], currency))}</td></tr>')
        headings = '<th scope="col">Metric</th><th scope="col">Previous</th><th scope="col">Current</th>'
    else:
        caption = f'{chart.get("cadence", "daily").capitalize()} activity · dates in {data["timezone"]} · yellow marks latest period'
        for point in chart.get("points", []):
            rows.append(f'<tr><th scope="row">{esc(point["date"])}</th><td>{esc(display(point["value"], chart["unit"], currency))}</td></tr>')
        headings = '<th scope="col">Date</th><th scope="col">Value</th>'
    table = (f'<details class="chart-data"><summary>View exact chart data</summary><table class="chart-table"><thead><tr>{headings}</tr></thead><tbody>{"".join(rows)}</tbody></table></details>' if rows else "")
    return (f'<figure class="chart-card"><div class="chart-heading"><h2>{esc(chart["title"])}</h2>'
            f'<span class="chart-unit">{esc(unit)}</span></div>{svg_chart(chart, data)}'
            f'<figcaption class="chart-caption">{esc(caption)}</figcaption>{table}</figure>')


performance_line_chart = growth_bar_chart
comparison_chart = growth_bar_chart


def executive_summary(data, required=False):
    items = data.get("executive_summary", [])
    if not items and not required:
        return ""
    content = ('<ul class="summary-list">' + "".join(f'<li>{esc(item["text"])}</li>' for item in items) + '</ul>') if items else '<p>N/A · No executive summary supplied.</p>'
    return f'<section class="summary"><div><h2>Executive summary</h2>{content}</div></section>'


def date_indicator(data):
    return f'{esc(data["period"]["start"])} – {esc(data["period"]["end"])}<br>{esc(data["timezone"])} · Report {esc(data["report_date"])}'


def report_footer(data):
    update = f'<p class="product-update">{esc(data["product_update"])}</p>' if data.get("product_update") else ""
    sources = "; ".join(f'{s["label"]} (as of {s["as_of"]})' for s in data["sources"])
    if not sources:
        sources = "N/A · No source data supplied"
    return (f'<footer class="footer">{update}<div class="footer-row"><div>'
            '<div class="footer-brand">CornGrid Infrastructure</div><div class="footer-site">corngrid.com</div>'
            f'</div><div class="period">{date_indicator(data)}</div></div><div class="sources">Sources: {esc(sources)}</div></footer>')


LAYOUT_CHECK = """<script>
window.addEventListener('load', async () => {
  await document.fonts.ready;
  const root = document.querySelector('.report'), box = root.getBoundingClientRect();
  const bad = [];
  if (document.body.classList.contains('export')) {
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('.visually-hidden') || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if(r.right>box.right+1 || r.bottom>box.bottom+1 || r.left<box.left-1 || r.top<box.top-1 || el.scrollWidth>el.clientWidth+2 && !['svg','text','line','rect','circle','polyline'].includes(el.tagName)) bad.push(el.className.baseVal || el.className || el.tagName);
    }
    if(root.scrollHeight>root.clientHeight+2) bad.push('report-height');
  }
  const result = document.createElement('meta');
  result.name='corngrid-layout'; result.content=bad.length ? 'overflow:'+bad.join(',') : 'ok';
  document.head.appendChild(result);
});
</script>"""


def render_html(data, logo, template=None, canvas=None, slide=None):
    name = template or REPORTS[data["report_type"]][1]
    styles = (ROOT / "templates" / "report.css").read_text(encoding="utf-8")
    body_class, canvas_style = "", ""
    if canvas:
        width, height, kind = canvas
        body_class = f"export {kind}" + (" slide" if slide else "")
        canvas_style = f"--canvas-width:{width}px;--canvas-height:{height}px"
    slots = dict(title=esc(REPORTS[data["report_type"]][0]), styles=styles,
                 body_class=body_class, canvas_style=canvas_style,
                 header=brand_header(data, logo), hero=statistical_highlight(data),
                 chart=growth_bar_chart(data), metrics=kpi_cards(data),
                 summary=executive_summary(data), footer=report_footer(data), layout_check=LAYOUT_CHECK)
    if slide:
        titles = {"overview": "Platform overview", "activity": "Activity over time",
                  "metrics": "Performance indicators", "summary": "Executive update"}
        if slide != "overview":
            slots["hero"] = f'<h1>{titles[slide]}</h1><p class="context">{esc(REPORTS[data["report_type"]][0])}</p>'
        slots["chart"] = slots["chart"] if slide == "activity" else ""
        if slide == "activity" and not slots["chart"]:
            slots["chart"] = '<div class="chart-card chart-empty">N/A · No activity chart supplied</div>'
        slots["metrics"] = slots["metrics"] if slide == "metrics" else ""
        slots["summary"] = executive_summary(data, required=True) if slide in {"overview", "summary"} else ""
        name = "daily-growth"
    return Template((ROOT / "templates" / f"{name}.html").read_text(encoding="utf-8")).substitute(slots)


def find_browser(explicit=None):
    if explicit:
        path = Path(explicit).expanduser().resolve()
        require(path.is_file(), f"Browser not found: {path}")
        return str(path)
    for command in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge"):
        path = shutil.which(command)
        if path:
            return path
    candidates = [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                  Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        if os.environ.get(env):
            for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "Chromium/Application/chrome.exe"):
                candidates.append(Path(os.environ[env]) / relative)
    for path in candidates:
        if path.is_file():
            return str(path)
    raise ReportError("PNG/PDF/PPTX need an installed Chrome, Edge or Chromium. Supply --browser; HTML export needs no browser.")


def png_size(path):
    with open(path, "rb") as stream:
        header = stream.read(24)
    require(header[:8] == b"\x89PNG\r\n\x1a\n", "Browser did not produce a valid PNG.")
    return struct.unpack(">II", header[16:24])


def browser_render(document, destination, canvas, browser, pdf=False):
    width, height, _ = canvas
    with tempfile.TemporaryDirectory(prefix="corngrid-render-") as temp:
        folder = Path(temp)
        page = folder / "report.html"
        page.write_text(document, encoding="utf-8")
        args = [browser, "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
                "--no-default-browser-check", "--hide-scrollbars", "--force-device-scale-factor=1",
                "--run-all-compositor-stages-before-draw", "--virtual-time-budget=2500",
                f"--user-data-dir={folder / 'profile'}", f"--window-size={width},{height}", "--dump-dom"]
        args.append(f"--print-to-pdf={destination}" if pdf else f"--screenshot={destination}")
        if pdf:
            args += ["--no-pdf-header-footer", "--print-to-pdf-no-header"]
        args.append(page.as_uri())
        try:
            result = subprocess.run(args, capture_output=True, timeout=55, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired as exc:
            raise ReportError("Browser rendering exceeded 55 seconds. Close stalled headless browser processes and retry.") from exc
        except OSError as exc:
            raise ReportError(f"Could not launch the browser: {exc}") from exc
        match = re.search(r'<meta name="corngrid-layout" content="([^"]+)"', result.stdout)
        require(match is not None, "Browser did not finish layout verification. Check browser permissions and --browser path.")
        require(match.group(1) == "ok", f"Content exceeds the canvas ({match.group(1)}). Shorten copy, reduce KPIs or choose a taller layout.")
        require(result.returncode == 0 and destination.is_file() and destination.stat().st_size > 100,
                f"Browser export failed (exit {result.returncode}). Check browser permissions and output directory.")
        if pdf:
            require(destination.read_bytes().startswith(b"%PDF-"), "Invalid PDF output.")
        else:
            require(png_size(destination) == (width, height), "PNG dimensions differ from the requested canvas.")


def write_pptx(slides, destination, title):
    """Minimal standards-based 16:9 OOXML deck, image-backed for fidelity."""
    pns = "http://schemas.openxmlformats.org/presentationml/2006/main"
    ans = "http://schemas.openxmlformats.org/drawingml/2006/main"
    rns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    def xml(body):
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body
    def rels(entries):
        return xml(f'<Relationships xmlns="{package_ns}">' + "".join(f'<Relationship Id="{rid}" Type="{rns}/{kind}" Target="{target}"/>' for rid, kind, target in entries) + '</Relationships>')
    group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    w, h = 12192000, 6858000
    overrides = [("/ppt/presentation.xml", "presentationml.presentation.main+xml"),
                 ("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml"),
                 ("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout+xml"),
                 ("/ppt/theme/theme1.xml", "theme+xml")]
    overrides += [(f"/ppt/slides/slide{i}.xml", "presentationml.slide+xml") for i in range(1, len(slides)+1)]
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        def put(path, content):
            archive.writestr(path, content)
        content_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
        for part, mime in overrides:
            prefix = "application/vnd.openxmlformats-officedocument."
            if mime == "theme+xml":
                prefix = "application/vnd.openxmlformats-officedocument."
            content_types += f'<Override PartName="{part}" ContentType="{prefix}{mime}"/>'
        put("[Content_Types].xml", xml(content_types + '</Types>'))
        put("_rels/.rels", rels([("rId1", "officeDocument", "ppt/presentation.xml")]))
        slide_ids = "".join(f'<p:sldId id="{255+i}" r:id="rId{i+1}"/>' for i in range(1, len(slides)+1))
        put("ppt/presentation.xml", xml(f'<p:presentation xmlns:p="{pns}" xmlns:a="{ans}" xmlns:r="{rns}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx="{w}" cy="{h}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'))
        put("ppt/_rels/presentation.xml.rels", rels([("rId1", "slideMaster", "slideMasters/slideMaster1.xml")] + [(f"rId{i+1}", "slide", f"slides/slide{i}.xml") for i in range(1, len(slides)+1)]))
        put("ppt/slideMasters/slideMaster1.xml", xml(f'<p:sldMaster xmlns:p="{pns}" xmlns:a="{ans}" xmlns:r="{rns}"><p:cSld><p:spTree>{group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'))
        put("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")]))
        put("ppt/slideLayouts/slideLayout1.xml", xml(f'<p:sldLayout xmlns:p="{pns}" xmlns:a="{ans}" xmlns:r="{rns}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'))
        put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]))
        colors = {"dk1":"000000", "lt1":"FFFFFF", "dk2":"1B1B1B", "lt2":"F8F6EF", "accent1":"FFEB00", "accent2":"777777", "accent3":"595959", "accent4":"D9D8D1", "accent5":"000000", "accent6":"FFEB00", "hlink":"000000", "folHlink":"595959"}
        scheme = "".join(f'<a:{name}><a:srgbClr val="{value}"/></a:{name}>' for name, value in colors.items())
        fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        line = '<a:ln w="9525">' + fill + '<a:prstDash val="solid"/></a:ln>'
        fmt = f'<a:fmtScheme name="CornGrid"><a:fillStyleLst>{fill*3}</a:fillStyleLst><a:lnStyleLst>{line*3}</a:lnStyleLst><a:effectStyleLst>{"<a:effectStyle><a:effectLst/></a:effectStyle>"*3}</a:effectStyleLst><a:bgFillStyleLst>{fill*3}</a:bgFillStyleLst></a:fmtScheme>'
        font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>'
        put("ppt/theme/theme1.xml", xml(f'<a:theme xmlns:a="{ans}" name="CornGrid"><a:themeElements><a:clrScheme name="CornGrid">{scheme}</a:clrScheme><a:fontScheme name="CornGrid"><a:majorFont>{font}</a:majorFont><a:minorFont>{font}</a:minorFont></a:fontScheme>{fmt}</a:themeElements></a:theme>'))
        for i, slide in enumerate(slides, 1):
            archive.write(slide, f"ppt/media/slide{i}.png")
            picture = f'<p:pic><p:nvPicPr><p:cNvPr id="2" name="CornGrid report slide {i}" descr="{xml_escape(title, {chr(34): "&quot;"})}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{w}" cy="{h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
            put(f"ppt/slides/slide{i}.xml", xml(f'<p:sld xmlns:p="{pns}" xmlns:a="{ans}" xmlns:r="{rns}"><p:cSld><p:spTree>{group}{picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'))
            put(f"ppt/slides/_rels/slide{i}.xml.rels", rels([("rId1", "image", f"../media/slide{i}.png"), ("rId2", "slideLayout", "../slideLayouts/slideLayout1.xml")]))


def sample_data():
    """Explicit synthetic fixture, never a production fallback."""
    names = [("users", "Registered users", 240, 200),
             ("registrations", "New registrations", 40, 32),
             ("active", "Weekly active users", 96, 80),
             ("mt5", "Active MT5 accounts", 64, 50),
             ("sandboxes", "Active sandboxes", 48, 40),
             ("subscribers", "Paying subscribers", 24, 20)]
    return {"mode":"sample", "report_type":"weekly-saas", "report_date":"2026-11-14",
            "timezone":"Asia/Kuala_Lumpur", "period":{"start":"2026-11-07", "end":"2026-11-13"},
            "comparison_period":{"start":"2026-10-31", "end":"2026-11-06"},
            "headline":"A clearer view of platform growth.", "hero_metric":"users", "secondary_metric":"registrations",
            "context":"Synthetic demonstration only. Replace these values with a verified CornGrid export.",
            "metrics":[{"id":mid,"label":label,"value":val,"previous":prev,"unit":"count","source":"demo","previous_source":"demo"} for mid,label,val,prev in names],
            "chart":{"type":"bar","title":"Daily active users","unit":"count","cadence":"daily",
                     "points":[{"date":f"2026-11-{7+i:02d}","value":val,"source":"demo"} for i,val in enumerate([18,24,21,32,28,40,48])]},
            "sources":[{"id":"demo","label":"Synthetic demonstration fixture","as_of":"2026-11-14T08:00:00+08:00"}],
            "executive_summary":[], "product_update":"Sample layout · no production statistics represented.", "product_update_source":"demo"}


def audit_record(data, logo, input_hash, fmt, size):
    return {"mode":data["mode"], "report_type":data["report_type"], "format":fmt,
            "size":size, "logo_sha256":hashlib.sha256(logo).hexdigest(), "input_sha256":input_hash,
            "data":data, "calculations":[{"metric_id":m["id"], "change":change(m),
            "change_unit":"percentage_points" if m["unit"] == "percent" else "percent", "display":change_label(m)} for m in data["metrics"]],
            "validation":"Structural, provenance-reference and arithmetic checks passed; originating facts and prose require agent verification."}


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    group = cli.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", type=Path, help="Verified JSON statistics; see references/data-validation.md")
    group.add_argument("--sample", action="store_true", help="Generate visibly labeled synthetic demo data")
    cli.add_argument("--format", choices=["html", "png", "pdf", "pptx"], default="html")
    cli.add_argument("--size", choices=list(SIZES), default=None, help="PNG size (default 1080x1350)")
    cli.add_argument("--template", choices=["daily-growth", "weekly-report", "investor-update", "social-infographic"])
    cli.add_argument("--output", type=Path)
    cli.add_argument("--browser", help="Absolute path to installed Chromium/Chrome/Edge")
    cli.add_argument("--force", action="store_true", help="Intentionally replace existing output and audit")
    cli.add_argument("--validate-only", action="store_true", help="Validate data and logo without exporting")
    return cli


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.sample:
            data = sample_data()
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        else:
            raw = args.input.read_bytes()
            def invalid_constant(value):
                raise ReportError(f"Nonfinite JSON value rejected: {value}.")
            def unique_keys(pairs):
                obj = {}
                for key, val in pairs:
                    require(key not in obj, f"Duplicate JSON key: {key}.")
                    obj[key] = val
                return obj
            data = json.loads(raw.decode("utf-8-sig"), parse_float=Decimal,
                              parse_constant=invalid_constant, object_pairs_hook=unique_keys)
        validate(data)
        logo = logo_bytes()
        if args.validate_only:
            print(f"Valid {data['mode']} input; official logo verified. No report generated.")
            return 0
        require(args.output is not None, "--output is required unless --validate-only is used.")
        require(args.size is None or args.format == "png", "--size applies only to PNG; PDF is A4 and PPTX is 16:9.")
        output = args.output.expanduser().resolve()
        require(output.suffix.lower() == "." + args.format, "Output extension must match --format.")
        audit_path = output.with_suffix(".audit.json")
        require(args.force or not output.exists() and not audit_path.exists(),
                "Output or audit already exists. Choose another name or use --force intentionally.")
        require(not args.input or output != args.input.resolve() and audit_path != args.input.resolve(),
                "Output must not replace input statistics.")
        output.parent.mkdir(parents=True, exist_ok=True)
        browser = find_browser(args.browser) if args.format != "html" else None
        with tempfile.TemporaryDirectory(prefix=".corngrid-export-", dir=output.parent) as temp:
            folder = Path(temp)
            staged = folder / output.name
            canvas = SIZES[args.size or "1080x1350"]
            if args.format == "html":
                staged.write_text(render_html(data, logo, args.template), encoding="utf-8")
                size = "responsive"
            elif args.format == "png":
                browser_render(render_html(data, logo, args.template, canvas), staged, canvas, browser)
                size = args.size or "1080x1350"
            elif args.format == "pdf":
                canvas = (794, 1122, "a4")
                browser_render(render_html(data, logo, args.template, canvas), staged, canvas, browser, pdf=True)
                size = "A4 portrait"
            else:
                canvas = SIZES["1920x1080"]
                slides = []
                for index, part in enumerate(("overview", "activity", "metrics", "summary"), 1):
                    slide = folder / f"slide{index}.png"
                    browser_render(render_html(data, logo, args.template, canvas, slide=part), slide, canvas, browser)
                    slides.append(slide)
                write_pptx(slides, staged, data["headline"])
                size = "16:9; four image-backed slides"
            record = audit_record(data, logo, hashlib.sha256(raw).hexdigest(), args.format, size)
            staged_audit = folder / "audit.json"
            staged_audit.write_text(json.dumps(record, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
            # Commit only after every render/validation step succeeds.
            os.replace(staged, output)
            os.replace(staged_audit, audit_path)
        print(f"Created {output}\nAudit: {audit_path}\nMode: {data['mode']} · Period: {data['period']['start']} – {data['period']['end']}")
        return 0
    except (ReportError, OSError, ValueError, TypeError, KeyError, InvalidOperation) as exc:
        print(f"Report error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
