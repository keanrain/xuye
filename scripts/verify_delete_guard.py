#!/usr/bin/env python3
"""Run fixed-ref deletion-guard red/green checks. No network or real vault."""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from verify_pinned import verify

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / "p0/pinned/9e948ba/web"
CANDIDATE = ROOT / "p0/candidates/delete-guard"
OUT = ROOT / "p0/results/delete-guard"
PATCH = ROOT / "p0/patches/0002-fail-closed-sync-scan.patch"

def make_patch() -> str:
    output = ["diff --git a/web/files.js b/web/files.js\n",
              "--- a/web/files.js\n", "+++ b/web/files.js\n"]
    delta = 0
    for first, name in [(278, "syncFilesWithServer"), (704, "collectModifiedAndDeletedFiles")]:
        before = (PIN / f"{name}.function.js").read_text()
        after = (CANDIDATE / f"{name}.function.js").read_text()
        lines = list(difflib.unified_diff(before.splitlines(True), after.splitlines(True), n=3))
        for line in lines[2:]:
            if line.startswith("@@"):
                m = re.fullmatch(r"@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)\n", line)
                if not m:
                    raise RuntimeError("Unexpected diff header")
                line = (f"@@ -{int(m[1])+first-1}{m[2] or ''} "
                        f"+{int(m[3])+first-1+delta}{m[4] or ''} @@{m[5]}\n")
            output.append(line)
        delta += len(after.splitlines()) - len(before.splitlines())
    return "".join(output)

def patch_context_check() -> dict:
    """Check mechanics only; deliberately NOT a full repository reconstruction."""
    if make_patch() != PATCH.read_text():
        raise RuntimeError("Patch does not reproduce the candidate code used in tests")
    with tempfile.TemporaryDirectory(prefix="xuye-patch-context-") as tmp:
        directory = Path(tmp)
        (directory / "web").mkdir()
        lines = ["// Unfetched upstream line: synthetic patch-context test only.\n"] * 1200
        for first, name in [(278, "syncFilesWithServer"), (704, "collectModifiedAndDeletedFiles"),
                            (813, "getFileStatus"), (994, "moveFile")]:
            part = (PIN / f"{name}.function.js").read_text().splitlines(True)
            lines[first-1:first-1+len(part)] = part
        file = directory / "web/files.js"
        file.write_text("".join(lines))
        logs = []
        for args in [
            ["git", "apply", "--check", str(PATCH)],
            ["git", "apply", str(PATCH)],
            ["git", "apply", "--check", str(ROOT / "p0/patches/0001-propagate-move-error.patch")],
        ]:
            cp = subprocess.run(args, cwd=directory, capture_output=True, text=True, timeout=10)
            logs.append({"command": args, "exit_code": cp.returncode, "stderr": cp.stderr})
            if cp.returncode:
                raise RuntimeError("Patch-context fixture failed: " + cp.stderr)
        applied = file.read_text()
        for name in ["syncFilesWithServer", "collectModifiedAndDeletedFiles"]:
            if (CANDIDATE / f"{name}.function.js").read_text() not in applied:
                raise RuntimeError("Applied patch does not match the tested candidate")
    return {"scope": "synthetic sparse file containing exact known ranges, NOT complete checkout",
            "candidate_bodies_match": True, "commands": logs}

def run_suite(mode: str) -> dict:
    env = os.environ.copy()
    env.pop("XUYE_DELETE_GUARD", None)
    if mode == "candidate":
        env["XUYE_DELETE_GUARD"] = "1"
    command = ["node", "--test", str(ROOT / "p0/tests/delete-guard.test.cjs")]
    cp = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, timeout=30)
    (OUT / f"{mode}.tap").write_text(cp.stdout)
    counts = {}
    for key in ["tests", "pass", "fail", "skipped", "cancelled", "todo"]:
        m = re.search(rf"^# {key} (\d+)$", cp.stdout, re.M)
        if not m:
            raise RuntimeError(f"No TAP {key} count from {mode}")
        counts[key] = int(m[1])
    expected_exit = 1 if mode == "baseline" else 0
    expected_fail = 14 if mode == "baseline" else 0
    matched = (cp.returncode == expected_exit and counts["tests"] == 18
               and counts["fail"] == expected_fail and counts["skipped"] == 0
               and counts["cancelled"] == 0 and counts["todo"] == 0)
    return {"mode": mode, "command": command, "exit_code": cp.returncode, **counts,
            "expected_exit": expected_exit, "expectation_matched": matched,
            "log": f"{mode}.tap",
            "failures": re.findall(r"^not ok \d+ - (.+)$", cp.stdout, re.M)}

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        target, checks = verify()
        context = patch_context_check()
        suites = [run_suite("baseline"), run_suite("candidate")]
        report = {
            "commit": target["commit"],
            "executed_at_utc": datetime.now(timezone.utc).isoformat(),
            "source_checks": checks,
            "scope": "fixed functions, original getFileStatus/read/exists, test-only Node disk handles and HTTP response seam",
            "full_checkout": False, "real_http_requests": 0, "real_user_vault_accessed": False,
            "candidate_integrated_in_application": False,
            "candidate_hashes": {
                str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in [PATCH, *sorted(CANDIDATE.glob("*.js")), ROOT/"p0/tests/delete-guard.test.cjs"]
            },
            "patch_context": context, "test_runs": suites,
            "remaining": [
                "legacy absence-based deletion is not a versioned user-authorized tombstone",
                "no whole-scan snapshot/lock, root binding proof, or check-to-upload atomicity",
                "other upload/download and individual-file sync paths are not guarded by this patch",
                "scan failure is logged; app-level UX has not been validated",
                "no browser, full application, server sync, container, mobile, or P0 acceptance"
            ],
            "all_expected_results_matched": all(r["expectation_matched"] for r in suites)
        }
        (OUT / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps({"test_runs": suites,
                          "all_expected_results_matched": report["all_expected_results_matched"]},
                         ensure_ascii=False, indent=2))
        return 0 if report["all_expected_results_matched"] else 1
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
        (OUT / "runner-error.log").write_text(f"{type(error).__name__}: {error}\n")
        print(str(error), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
