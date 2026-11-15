"""Read-only pre-commit inventory. Reports locations, never credential values.

No backend environment is loaded, no network calls are made, and archives are
inspected in memory without extracting their contents to the workspace.
"""
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = [
    ("Stripe secret", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b")),
    ("Webhook secret", re.compile(r"\bwhsec_[A-Za-z0-9]{20,}\b")),
    ("Node credential", re.compile(r"\bcgn_[a-f0-9]{64}\b")),
    ("Private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("AWS credential", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub credential", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("Literal credential", re.compile(r'''(?i)(?:password|passwd|api_?key|api_?secret|access_?token|client_?secret|node_?token)\s*["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']''')),
    ("Credential URL", re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb|https?)://[^\s/@:]+:[^\s/@]+@")),
]
TEXT = {".js", ".cjs", ".mjs", ".py", ".ps1", ".sh", ".json", ".md", ".html", ".css", ".yaml", ".yml", ".xml", ".config", ".txt", ".sql", ".gradle", ".toml", ".ini"}
findings = []
warnings = []


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT).decode("utf-8").split("\0")


def private_file(name):
    return bool(re.search(r"(?:^|/)(?:\.env(?:\..+)?|agent-config\.json|signing-key\.pem|update-trust\.pem|cookies?\.json)$|\.(?:sqlite(?:-wal|-shm)?|jks|keystore|rdp|pfx|p12)$", name, re.I)) and not name.endswith(".env.example")


def scan(name, data):
    if private_file(name):
        findings.append({"file": name, "rule": "Private runtime file"})
    suffix = Path(name).suffix.lower()
    if suffix in {".zip", ".pptx"}:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if sum(item.file_size for item in entries) > 200 * 1024 * 1024:
                    findings.append({"file": name, "rule": "Archive exceeds review budget"})
                    return
                for item in entries:
                    if item.is_dir():
                        continue
                    if ".." in Path(item.filename).parts or item.filename.startswith(("/", "\\")):
                        findings.append({"file": name, "rule": "Unsafe archive member"})
                        continue
                    scan(name + "!" + item.filename, archive.read(item))
        except (zipfile.BadZipFile, RuntimeError):
            findings.append({"file": name, "rule": "Cannot inspect archive"})
        return
    if suffix not in TEXT and Path(name).name not in {".gitignore", ".gitattributes", "SKILL.md"}:
        return
    body = data.decode("utf-8-sig", errors="replace")
    for rule, pattern in RULES:
        for match in pattern.finditer(body):
            value = match.group(1) if rule == "Literal credential" else match.group()
            if any(word in value.lower() for word in ("fixture", "placeholder", "example", "notreal", "fake", "for_test", "your_", "test-", "test_")):
                continue
            if rule == "Literal credential" and (len(set(value)) < 6 or any(word in value for word in ("${", "process.env", "$env:", "<", ">", "' +", '" +', "cgn_x", "x" * 10, "password", "secret", "token"))):
                continue
            if rule == "Node credential" and "/test/" in name and len(set(value[4:])) < 5:
                continue
            findings.append({"file": name, "line": body[:match.start()].count("\n") + 1, "rule": rule})
    if name.endswith("stripe-live-verification.json"):
        warnings.append({"file": name, "rule": "Local payment verification report"})


files = sorted(set(filter(None, git("diff", "HEAD", "--name-only", "-z") + git("ls-files", "--others", "--exclude-standard", "-z"))))
total = 0
for name in files:
    target = ROOT / name
    if not target.exists():
        continue
    if target.is_symlink():
        findings.append({"file": name, "rule": "Symlink requires review"})
        continue
    data = target.read_bytes()
    total += len(data)
    if len(data) > 50 * 1024 * 1024:
        findings.append({"file": name, "rule": "Large artifact requires review"})
    scan(name, data)
result = {"files": len(files), "bytes": total, "findings": findings, "warnings": warnings}
(ROOT / "marketing/all-changes-review-result.json").write_text(json.dumps({**result, "paths": files}, indent=2), encoding="utf-8")
print(json.dumps(result))
raise SystemExit(1 if findings else 0)
