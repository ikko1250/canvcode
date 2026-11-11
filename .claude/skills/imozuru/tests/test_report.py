"""report.html の「届かなかったもの」に、URL をリンクで出すことを検査する（MAI-97）。"""

import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("report_unreached", ROOT / "scripts" / "report.py")
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


class UnreachedTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.topic = Path(tmp.name) / "demo"
        shutil.copytree(ROOT / "examples" / "demo", self.topic)

    def render(self, unreached):
        data = json.loads((self.topic / "extracts.json").read_text(encoding="utf-8"))
        data["unreached"] = unreached
        (self.topic / "extracts.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with patch.object(sys, "argv", ["report.py", str(self.topic)]), contextlib.redirect_stdout(io.StringIO()):
            code = report.main()
        page = (self.topic / "report.html").read_text(encoding="utf-8")
        return code, page[page.find("<h2>届かなかったもの"):]

    def test_url_is_a_link_with_reason(self):
        code, section = self.render([{"title": "有料の論文 <定番>", "url": "https://example.com/a?b=1&c=2", "reason": "有料"}])
        self.assertEqual(code, 0)
        self.assertIn('<a href="https://example.com/a?b=1&amp;c=2" rel="noreferrer">有料の論文 &lt;定番&gt;</a>', section)
        self.assertIn('<span class="reason"> — 有料</span>', section)
        # 印刷しても URL が読めるよう、文字でも出す
        self.assertIn('<code class="url">https://example.com/a?b=1&amp;c=2</code>', section)

    def test_old_string_form_and_items_without_url(self):
        code, section = self.render(["古い形の届かなかったもの", {"title": "見つからなかった記録", "reason": "探した範囲に無い"}])
        self.assertEqual(code, 0)
        self.assertIn("<li>古い形の届かなかったもの</li>", section)
        self.assertIn("<li>見つからなかった記録<span class=\"reason\"> — 探した範囲に無い</span></li>", section)
        self.assertNotIn("<a ", section.split("</ul>")[0])

    def test_non_web_urls_are_not_linked(self):
        for url in ("javascript:alert(1)", "file:///etc/passwd", "https://", "http://a b", ""):
            with self.subTest(url=url):
                code, section = self.render([{"title": "危ない", "url": url}])
                self.assertEqual(code, 0)
                self.assertNotIn("<a ", section.split("</ul>")[0])

    def test_items(self):
        data = {"unreached": ["古い", {"url": "https://example.com/x"}, {"title": " 名前 ", "url": "ftp://x", "reason": None}]}
        self.assertEqual(report.unreached_items(data), [
            {"title": "古い", "url": None, "reason": ""},
            {"title": "https://example.com/x", "url": "https://example.com/x", "reason": ""},
            {"title": "名前", "url": None, "reason": ""},
        ])
        with self.assertRaises(SystemExit):
            report.unreached_items({"unreached": [3]})


if __name__ == "__main__":
    unittest.main()
