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
        # 原文の持ち主は右端の列に1つずつ。Markdown はカード、PDF の .txt は PDF の Portal。どちらもワークスペースの中のパスで指す
        # 2つの主張・1つの食い違い・届かなかったものの4列の右
        self.assertEqual((by_as["src"]["x"], by_as["src"]["y"]), (4 * canvas.COL_STEP, 260))
        self.assertEqual(by_as["map"], {"op": "create", "type": "card", "as": "map", "path": "research/demo/map.md",
                                        "place": {"below": "$src", "gap": 24}, "w": 360, "h": 420})
        self.assertNotIn("log", by_as)
        self.assertEqual((by_as["s0"]["type"], by_as["s0"]["path"]), ("card", "research/demo/sources/sample-blog.md"))
        self.assertEqual((by_as["s1"]["type"], by_as["s1"]["path"], by_as["s1"]["name"]), ("pdf", "research/demo/sources/sample-paper.pdf", "sample-paper"))
        self.assertEqual([op["type"] for op in ops if op["op"] == "create" and op.get("path", "").endswith("sample-paper.pdf")], ["pdf"])
        # 列の右の帯に、その列が引く原文のショートカット。PDF は持ち主の Portal を target にした portal、Markdown は同じパスのカード
        self.assertEqual(by_as["c0_s0"], {"op": "create", "type": "card", "as": "c0_s0", "path": "research/demo/sources/sample-blog.md",
                                          "w": 240, "place": {"rightOf": "$c0", "gap": 40}})
        self.assertEqual(by_as["c0_s1"], {"op": "create", "type": "portal", "as": "c0_s1", "target": "$s1", "w": 240, "h": 320,
                                          "place": {"below": "$c0_s0", "gap": 24}})
        self.assertEqual(by_as["c1_s1"]["place"], {"rightOf": "$c1", "gap": 40})
        self.assertEqual((by_as["c1"]["x"], by_as["d0"]["x"]), (canvas.COL_STEP, 2 * canvas.COL_STEP))
        # 持ち主はショートカットより先に作る（$s<N> で指し、Markdown のカードがショートカットになるように）
        order = [op.get("as") for op in ops]
        self.assertLess(order.index("s0"), order.index("c0_s0"))
        self.assertLess(order.index("s1"), order.index("c0_s1"))
        # 矢印は付箋から同じ列のショートカットへ。持ち主へは引かない
        arrows = [(op["from"], op["to"]) for op in ops if op["op"] == "connect"]
        self.assertEqual(arrows, [("$c0q0", "$c0_s0"), ("$c0q1", "$c0_s1"), ("$c1q0", "$c1_s1"), ("$d0q0", "$d0_s0")])

    def test_shortcuts_in_order_of_first_use_in_a_column(self):
        (self.topic / "sources" / "sample-paper.pdf").write_bytes(b"%PDF-1.4\n")
        data = json.loads((self.topic / "extracts.json").read_text(encoding="utf-8"))
        blog, paper = data["claims"][0]["quotes"]
        data["claims"][0]["quotes"] = [paper, blog, data["claims"][1]["quotes"][0]]
        (self.topic / "extracts.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        ops = self.ops()
        side = [(op["as"], op["place"]) for op in ops if op.get("as", "").startswith("c0_")]
        self.assertEqual(side, [("c0_s0", {"rightOf": "$c0", "gap": 40}), ("c0_s1", {"below": "$c0_s0", "gap": 24})])
        # 原文の名前は全体で初めて出てきた順（paper が s0）。同じ列で2度目の原文は、同じショートカットへ
        self.assertEqual(next(op for op in ops if op.get("as") == "c0_s0")["target"], "$s0")
        arrows = [(op["from"], op["to"]) for op in ops if op["op"] == "connect" and op["from"].startswith("$c0")]
        self.assertEqual(arrows, [("$c0q0", "$c0_s0"), ("$c0q1", "$c0_s1"), ("$c0q2", "$c0_s0")])
        # 持ち主は原文ごとに1つ
        owners = [op["as"] for op in ops if op.get("as") in ("s0", "s1", "s2")]
        self.assertEqual(owners, ["s0", "s1"])

    def test_text_without_pdf_is_only_named(self):
        ops = self.ops()
        s1 = next(op for op in ops if op.get("as") == "s1")
        self.assertEqual((s1["type"], s1["text"]), ("note", "sources/sample-paper.txt"))
        # 列の帯にも、同じ場所の付箋を置く
        c1_s1 = next(op for op in ops if op.get("as") == "c1_s1")
        self.assertEqual((c1_s1["type"], c1_s1["text"], c1_s1["w"]), ("note", "sources/sample-paper.txt", 240))

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
