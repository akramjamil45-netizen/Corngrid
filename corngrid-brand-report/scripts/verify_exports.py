"""Render synthetic examples in every supported format; never accesses live data."""
import argparse
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("generate-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--output-dir", type=Path, required=True)
    cli.add_argument("--browser")
    args = cli.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    jobs = [("html", "sample-weekly.html", None),
            ("png", "sample-portrait.png", "1080x1350"),
            ("png", "sample-story.png", "1080x1920"),
            ("png", "sample-landscape.png", "1920x1080"),
            ("pdf", "sample-a4.pdf", None),
            ("pptx", "sample-investor.pptx", None)]
    for fmt, name, size in jobs:
        command = ["--sample", "--format", fmt, "--output", str(args.output_dir / name), "--force"]
        if size:
            command += ["--size", size]
        if args.browser:
            command += ["--browser", args.browser]
        result = report.main(command)
        if result:
            return result
    print("All supported export formats rendered successfully using synthetic data.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
