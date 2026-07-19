"""Extract the one CV in workspace/inbox as plain text for Codex."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


SUPPORTED_SUFFIXES = {".pdf", ".docx", ".md", ".txt"}
WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter(f"{WORD_NAMESPACE}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{WORD_NAMESPACE}t"))
        if text.strip():
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_pdf(path: Path) -> str:
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        raise RuntimeError("PDF extraction needs pdftotext (Poppler). Use DOCX, Markdown, or text instead.")
    result = subprocess.run([pdftotext, "-layout", str(path), "-"], text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "pdftotext could not read the PDF.")
    return result.stdout


def read_inbox_cv(inbox: Path) -> tuple[Path, str]:
    candidates = sorted(
        path for path in inbox.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    ) if inbox.exists() else []
    if not candidates:
        raise RuntimeError("No CV found. Put one PDF, DOCX, Markdown, or text file in workspace/inbox/.")
    if len(candidates) != 1:
        raise RuntimeError("Keep exactly one CV in workspace/inbox/.")

    path = candidates[0]
    suffix = path.suffix.lower()
    text = path.read_text(encoding="utf-8-sig") if suffix in {".md", ".txt"} else extract_docx(path) if suffix == ".docx" else extract_pdf(path)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise RuntimeError(f"{path.name} did not contain readable text.")
    return path, text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inbox", nargs="?", default="workspace/inbox", type=Path)
    inbox = parser.parse_args().inbox
    try:
        path, text = read_inbox_cv(inbox)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"# CV: {path.name}\n\n{text}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
