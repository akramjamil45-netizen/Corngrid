"""Meaningful data-integrity and export checks; no application/database access."""
import copy
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("generate-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.data = report.sample_data()
        self.data["mode"] = "production"
        self.data["headline"] = "User-supplied test fixture"

    def reject(self, fragment):
        with self.assertRaisesRegex(report.ReportError, fragment):
            report.validate(self.data)

    def test_valid_source_referenced_production_input(self):
        report.validate(self.data)

    def test_all_ten_report_types_render_offline(self):
        logo = report.logo_bytes()
        for kind in report.REPORTS:
            with self.subTest(kind=kind):
                self.data["report_type"] = kind
                report.validate(self.data)
                output = report.render_html(self.data, logo)
                self.assertIn("data:image/png;base64,", output)
                self.assertNotIn('src="http', output)
                self.assertIn("corngrid.com", output)

    def test_missing_values_never_become_zero(self):
        self.data["metrics"][0]["value"] = None
        self.data["metrics"][0]["previous"] = None
        report.validate(self.data)
        self.assertEqual(report.display(None), "N/A")
        self.assertIsNone(report.change(self.data["metrics"][0]))
        self.assertIn('hero-stat">N/A', report.statistical_highlight(self.data))

    def test_growth_uses_decimal_and_zero_baseline_is_undefined(self):
        metric = {"unit":"count", "value":120, "previous":100}
        self.assertEqual(report.change(metric), Decimal(20))
        metric.update(value=0, previous=0)
        self.assertIsNone(report.change(metric))
        metric.update(value=2, previous=-1)
        self.assertIsNone(report.change(metric))
        metric.update(value=Decimal("0.3"), previous=Decimal("0.1"))
        self.assertEqual(report.change(metric), Decimal(200))

    def test_percent_comparisons_use_percentage_points(self):
        metric = {"unit":"percent", "value":80, "previous":75}
        self.assertEqual(report.change_label(metric), "+5 pp vs prior period")

    def test_negative_counts_rejected(self):
        self.data["metrics"][0]["value"] = -1
        self.reject("nonnegative integer")

    def test_fractional_and_boolean_counts_rejected(self):
        for value in (1.5, True):
            self.data["metrics"][0]["value"] = value
            self.reject("integer|number or null")

    def test_nonfinite_rejected(self):
        self.data["metrics"][0]["value"] = float("nan")
        self.reject("finite")

    def test_production_value_requires_source(self):
        del self.data["metrics"][0]["source"]
        self.reject("valid source")

    def test_unknown_previous_source_rejected(self):
        self.data["metrics"][0]["previous_source"] = "missing"
        self.reject("valid source")

    def test_stale_and_future_sources_rejected(self):
        self.data["sources"][0]["as_of"] = "2026-11-01T00:00:00+08:00"
        self.reject("predates")
        self.data["sources"][0]["as_of"] = "2026-11-15T00:00:00+08:00"
        self.reject("after report_date")

    def test_source_needs_explicit_timezone(self):
        self.data["sources"][0]["as_of"] = "2026-11-14T08:00:00"
        self.reject("UTC offset")

    def test_unequal_and_overlapping_comparisons_rejected(self):
        self.data["comparison_period"]["start"] = "2026-10-30"
        self.reject("equal-duration")
        self.data["comparison_period"] = {"start":"2026-11-02", "end":"2026-11-08"}
        self.reject("without overlap")

    def test_adjacent_full_calendar_months_allowed(self):
        self.data["report_type"] = "monthly-business"
        self.data["period"] = {"start":"2026-10-01", "end":"2026-10-31"}
        self.data["comparison_period"] = {"start":"2026-09-01", "end":"2026-09-30"}
        self.data["chart"] = None
        report.validate(self.data)

    def test_missing_chart_dates_need_null_points(self):
        self.data["chart"]["points"].pop(2)
        self.reject("null points")
        self.data["chart"]["points"].insert(2, {"date":"2026-11-09", "value":None})
        report.validate(self.data)
        self.assertIn("N/A", report.growth_bar_chart(self.data))

    def test_line_chart_has_gaps_for_nulls(self):
        self.data["chart"]["type"] = "line"
        self.data["chart"]["points"][3]["value"] = None
        report.validate(self.data)
        self.assertEqual(report.svg_chart(self.data["chart"], self.data).count("<polyline"), 2)

    def test_comparison_chart_rejects_mixed_units(self):
        self.data["chart"] = {"type":"comparison", "title":"Comparison", "unit":"count"}
        self.data["metrics"][0]["unit"] = "percent"
        self.reject("mix units")

    def test_empty_chart_does_not_invent_a_series(self):
        self.data["chart"]["points"] = []
        report.validate(self.data)
        output = report.growth_bar_chart(self.data)
        self.assertIn("N/A", output)
        self.assertNotIn("<rect", output)

    def test_untrusted_copy_is_escaped(self):
        self.data["headline"] = '<img src=x onerror="alert(1)">'
        output = report.render_html(self.data, report.logo_bytes())
        self.assertIn("&lt;img", output)
        self.assertNotIn("<img src=x", output)

    def test_sample_mode_is_visible_on_every_deck_slide(self):
        data = report.sample_data()
        for part in ("overview", "activity", "metrics", "summary"):
            output = report.render_html(data, report.logo_bytes(), canvas=report.SIZES["1920x1080"], slide=part)
            self.assertIn("SAMPLE · SYNTHETIC DATA", output)

    def test_missing_or_modified_logo_blocks_rendering(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(report, "ROOT", Path(temp)):
                with self.assertRaisesRegex(report.ReportError, "logo missing"):
                    report.logo_bytes()
                (Path(temp) / "assets").mkdir()
                (Path(temp) / "assets/corngrid-logo.png").write_bytes(b"not the logo")
                with self.assertRaisesRegex(report.ReportError, "integrity"):
                    report.logo_bytes()

    def test_pptx_relationships_resolve_and_images_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            slide = folder / "slide.png"
            slide.write_bytes(report.logo_bytes())
            pptx = folder / "deck.pptx"
            report.write_pptx([slide] * 4, pptx, 'CornGrid "test" & progress')
            import posixpath
            with zipfile.ZipFile(pptx) as archive:
                names = archive.namelist()
                self.assertEqual(len([p for p in names if p.startswith("ppt/slides/slide") and p.endswith(".xml")]), 4)
                for name in names:
                    if name.endswith((".xml", ".rels")):
                        root = ET.fromstring(archive.read(name))
                        if name.endswith(".rels"):
                            base = "" if name == "_rels/.rels" else posixpath.dirname(posixpath.dirname(name))
                            for relation in root:
                                target = posixpath.normpath(posixpath.join(base, relation.attrib["Target"]))
                                self.assertIn(target, names)
                self.assertEqual(archive.read("ppt/media/slide1.png"), slide.read_bytes())

    def test_cli_does_not_overwrite_existing_output_or_accept_duplicate_keys(self):
        script = str(Path(report.__file__))
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            out = folder / "report.html"
            out.write_text("keep me", encoding="utf-8")
            code = subprocess.run([sys.executable, script, "--sample", "--output", str(out)], capture_output=True)
            self.assertNotEqual(code.returncode, 0)
            self.assertEqual(out.read_text(encoding="utf-8"), "keep me")
            datafile = folder / "duplicate.json"
            datafile.write_text('{"mode":"sample","mode":"production"}', encoding="utf-8")
            code = subprocess.run([sys.executable, script, "--input", str(datafile), "--validate-only"], capture_output=True)
            self.assertNotEqual(code.returncode, 0)
            self.assertIn(b"Duplicate JSON key", code.stderr)


if __name__ == "__main__":
    unittest.main()
