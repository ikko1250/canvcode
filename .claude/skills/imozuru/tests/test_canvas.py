"""抜き書きを CanvCode の Canvas に並べる操作（canvas.py）を検査する。"""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(f"canvas_{name}", ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


canvas = load("canvas")


class CanvasTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.workspace = Path(tmp.name)
        self.topic = self.workspace / "research" / "demo"
        shutil.copytree(ROOT / "examples" / "demo", self.topic)

    def ops(self):
        ops, bad = canvas.build(self.topic, self.workspace)
        self.assertEqual(bad, [])
        return ops

    def test_columns_quotes_and_sources(self):
        (self.topic / "map.md").write_text("# map\n", encoding="utf-8")
        # PDF の .txt の2ページ目の行（\f のあと）を抜き書きすると、付箋にページが出る
        txt = self.topic / "sources" / "sample-paper.txt"
        txt.write_text("\f" + txt.read_text(encoding="utf-8"), encoding="utf-8")
        (self.topic / "sources" / "sample-paper.pdf").write_bytes(b"%PDF-1.4\n")
        ops = self.ops()
        by_as = {op["as"]: op for op in ops if "as" in op}
        # 主張ごとの列の頭（状態で色が変わる）と、その下の抜き書き
        self.assertEqual(by_as["c0"]["color"], "#d3f9d8")
        self.assertEqual(by_as["c1"]["color"], "#fff3bf")
        self.assertEqual(by_as["c0q0"]["place"], {"below": "$c0", "gap": 24})
        self.assertIn("「わたしは影を塗るとき、まず一番暗い色を先に置く。", by_as["c0q0"]["text"])
        self.assertIn("— sample-blog.md:5-6", by_as["c0q0"]["text"])
        self.assertIn("sample-paper.txt:6-8（p.2）", by_as["c0q1"]["text"])
        self.assertIn("訳: 12件中9件で", by_as["c0q1"]["text"])
        # 原文は、Markdown はカード、PDF の .txt は PDF の Portal。どちらもワークスペースの中のパスで指す
        self.assertEqual(by_as["map"], {"op": "create", "type": "card", "as": "map", "path": "research/demo/map.md",
                                        "place": {"below": "$src", "gap": 24}, "w": 360, "h": 420})
        self.assertNotIn("log", by_as)
        self.assertEqual((by_as["s0"]["type"], by_as["s0"]["path"]), ("card", "research/demo/sources/sample-blog.md"))
        self.assertEqual((by_as["s1"]["type"], by_as["s1"]["path"], by_as["s1"]["name"]), ("pdf", "research/demo/sources/sample-paper.pdf", "sample-paper"))
        arrows = [(op["from"], op["to"]) for op in ops if op["op"] == "connect"]
        self.assertEqual(arrows, [("$c0q0", "$s0"), ("$c0q1", "$s1"), ("$c1q0", "$s1"), ("$d0q0", "$s0")])

    def test_text_without_pdf_is_only_named(self):
        ops = self.ops()
        s1 = next(op for op in ops if op.get("as") == "s1")
        self.assertEqual((s1["type"], s1["text"]), ("note", "sources/sample-paper.txt"))

    def test_refuses_paraphrased_quotes(self):
        data = json.loads((self.topic / "extracts.json").read_text(encoding="utf-8"))
        data["claims"][0]["quotes"][0]["text"] = "暗い色から塗ると濁らない。"
        (self.topic / "extracts.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        ops, bad = canvas.build(self.topic, self.workspace)
        self.assertEqual(ops, [])
        self.assertEqual(len(bad), 1)

    def test_refuses_a_topic_outside_the_workspace(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        with self.assertRaises(SystemExit):
            canvas.build(self.topic, Path(other.name))


if __name__ == "__main__":
    unittest.main()
