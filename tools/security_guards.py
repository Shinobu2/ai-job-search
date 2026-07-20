#!/usr/bin/env python3
"""Privacy and supply-chain guards for the personal job-search fork.

Run from anywhere: python tools/security_guards.py

Checks:
1. .gitignore — the personal-data ignore rules must all still be present.
   Catches weakening that would make future users silently commit their
   CV, generated documents, or local workspace data.
2. package.json and .agents/**/package.json — no npm/bun lifecycle scripts
   (preinstall, install, postinstall, prepare, prepack) and no
   trustedDependencies.
   Catches code execution smuggled into `bun install`.
3. workspace/** — no files except the inbox placeholder may be tracked.

Stdlib only. Exit 0 on success, 1 with a failure list otherwise.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors: list[str] = []

# Personal-data ignore rules that must never disappear from .gitignore.
REQUIRED_IGNORE_RULES = [
    "salary_data.json",
    "cv/main_*.tex",
    "!cv/main_example.tex",
    "cover_letters/cover_*.tex",
    ".vs/",
    "workspace/",
]

FORBIDDEN_SCRIPTS = {"preinstall", "install", "postinstall", "prepare", "prepack"}


def check_gitignore() -> None:
    path = ROOT / ".gitignore"
    try:
        rules = {line.strip() for line in path.read_text(encoding="utf-8").splitlines()}
    except OSError as exc:
        errors.append(f".gitignore: unreadable: {exc}")
        return
    for rule in REQUIRED_IGNORE_RULES:
        if rule not in rules:
            errors.append(
                f".gitignore: required personal-data rule missing: {rule!r}. "
                "These rules keep fork users from committing personal data. If the rule moved "
                "or was renamed intentionally, update REQUIRED_IGNORE_RULES in "
                "tools/security_guards.py in the same PR."
            )


def check_package_manifests() -> None:
    root_manifest = ROOT / "package.json"
    manifests = [root_manifest] + [
        p for p in ROOT.glob(".agents/**/package.json") if "node_modules" not in p.parts
    ]
    if not root_manifest.exists():
        errors.append("package.json: root manifest is missing")
    agent_manifests = manifests[1:]
    if not agent_manifests:
        errors.append(".agents: no package.json files found - glob roots are wrong or the tree moved")
    for manifest in manifests:
        relpath = manifest.relative_to(ROOT)
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{relpath}: unreadable or invalid JSON: {exc}")
            continue
        bad = FORBIDDEN_SCRIPTS & set(data.get("scripts", {}))
        if bad:
            errors.append(
                f"{relpath}: lifecycle script(s) {sorted(bad)} are forbidden - they execute "
                "arbitrary code during `bun install` on every fork user's machine."
            )
        if "trustedDependencies" in data:
            errors.append(
                f"{relpath}: trustedDependencies is forbidden - it re-enables dependency "
                "lifecycle scripts that bun blocks by default."
            )


def check_tracked_workspace_files() -> None:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "--", "workspace"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return
    if result.returncode != 0:
        return
    for path in filter(None, result.stdout.splitlines()):
        if path == "workspace/inbox/.gitkeep":
            continue
        errors.append(
            f"{path}: tracked workspace file is forbidden - workspace data is personal and must remain local."
        )


def main() -> int:
    check_gitignore()
    check_package_manifests()
    check_tracked_workspace_files()
    if errors:
        print(f"security_guards: {len(errors)} failure(s)")
        for err in errors:
            print(f"  - {err}")
        return 1
    print("security_guards: OK (gitignore rules, package manifests, workspace privacy)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
