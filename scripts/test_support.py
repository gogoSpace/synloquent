#!/usr/bin/env python3
"""Source identity and structured report checks shared by development tools."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
EXCLUDED_DIRECTORIES = {
    ".git", ".local", ".agentic", "node_modules", "vendor", "dist", "build", "Pods", ".gradle",
    "DerivedData", "coverage", ".phpstan.cache", ".phpunit.cache", "__pycache__",
    ".cxx", ".externalNativeBuild", ".kotlin",
}

def fingerprint(repository: Path | None = None) -> str:
    repository = repository or REPOSITORY
    digest = hashlib.sha256()
    paths = []
    for directory, children, filenames in os.walk(repository):
        children[:] = sorted(child for child in children if child not in EXCLUDED_DIRECTORIES and child != ".agentic")
        for filename in filenames:
            if filename in {".DS_Store", "local.properties", ".phpunit.result.cache"} or (filename.startswith(".env") and filename != ".env.example"):
                continue
            paths.append(Path(directory) / filename)
    for path in sorted(paths):
        contents = path.read_bytes()
        digest.update(str(path.relative_to(repository)).encode("utf-8") + b"\0")
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()

def utc_time() -> str:
    return datetime.now(timezone.utc).isoformat()

def validate_report(path: Path, report_format: str, required_scenarios: list[str], candidate: str) -> dict[str, object]:
    if report_format not in {"node-junit", "phpunit-junit", "scenarios-json"}:
        raise ValueError("Unknown structured report format")
    if not path.is_file():
        raise ValueError("Test command did not produce a structured report")
    content = path.read_bytes()
    if report_format in {"node-junit", "phpunit-junit"}:
        report = ElementTree.fromstring(content)
        if report.tag not in {'testsuite', 'testsuites'}:
            raise ValueError('Malformed JUnit report root')
        cases = list(report.iter("testcase"))
        failures = len(list(report.iter('failure'))) + len(list(report.iter('error')))
        skipped = len(list(report.iter('skipped')))
        for suite in [*report.iter('testsuite'), *report.iter('testsuites')]:
            for counter in ('failures', 'errors', 'skipped', 'disabled'):
                if counter not in suite.attrib:
                    continue
                raw_count = suite.attrib[counter]
                if not raw_count.isascii() or not raw_count.isdecimal():
                    raise ValueError('Malformed JUnit suite outcome counter')
                if int(raw_count):
                    raise ValueError('JUnit suite reports failed, errored or skipped outcomes')
        if any(not case.get('name', '').strip() for case in cases):
            raise ValueError('JUnit testcase has no inspectable name')
        names = {case.get("name", "") for case in cases}
    else:
        report = json.loads(content)
        if report.get("fingerprint") != candidate:
            raise ValueError("Scenario report is stale")
        cases = report.get("scenarios")
        if not isinstance(cases, list) or any(not isinstance(case, dict) or not isinstance(case.get("name"), str) or not case["name"] or case.get("status") not in {"pass", "fail", "skipped"} for case in cases):
            raise ValueError("Malformed scenario outcomes")
        failures = sum(case["status"] == "fail" for case in cases)
        skipped = sum(case["status"] == "skipped" for case in cases)
        names = {case.get("name", "") for case in cases}
        if len(names) != len(cases):
            raise ValueError("Duplicate scenario outcomes")
        if type(report.get('exitStatus')) is not int or report['exitStatus'] != 0:
            failures += 1
    if not cases or failures or skipped or set(required_scenarios) - names:
        raise ValueError(f"Required scenarios not accepted: count={len(cases)}, failures={failures}, skips={skipped}, missing={sorted(set(required_scenarios) - names)}")
    return {"count": len(cases), "failures": failures, "skipped": skipped, "scenarios": sorted(names), "sha256": hashlib.sha256(content).hexdigest()}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Print the current development source fingerprint")
    parser.add_argument("--fingerprint", action="store_true")
    parser.parse_args()
    print(fingerprint())
