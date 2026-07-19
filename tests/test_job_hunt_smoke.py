"""End-to-end smoke test for the first step of the personal job-hunt workflow."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class JobHuntSmokeTest(unittest.TestCase):
    def test_markdown_cv_in_inbox_is_extracted_for_the_job_search(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            inbox = Path(temporary_directory) / "workspace" / "inbox"
            inbox.mkdir(parents=True)
            (inbox / "candidate.md").write_text(
                "# Ada Example\n\nData center technician in Frankfurt.", encoding="utf-8"
            )

            result = subprocess.run(
                [sys.executable, "tools/extract_cv.py", str(inbox)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Ada Example", result.stdout)
            self.assertIn("Data center technician in Frankfurt", result.stdout)

if __name__ == "__main__":
    unittest.main()
