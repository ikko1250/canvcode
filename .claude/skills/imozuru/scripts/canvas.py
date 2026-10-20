#!/usr/bin/env python3
"""抜き書き（extracts.json）を、CanvCode の Canvas に並べる操作（MCP の edit_canvas の ops）にする。

report.html は縦に長い1枚のページ。CanvCode では同じ抜き書きを Canvas に置き、主張ごとの列に
抜き書きの付箋を並べ、付箋から原文（Markdown のカード・PDF の Portal）へ矢印を引く。
原文はワークスペースの中のファイルのままなので、カードや Portal からそのまま開いて前後を読める。

report.py と同じ照合を先に行い、1つでも合わなければ ops を作らずに止まる（言い換えが Canvas に紛れ込むのを防ぐ）。
エージェントが書いた見出し・状態・注記・訳のほかは、原文から切り出した文だけを付箋に入れる。

使い方:
    canvas.py <topic_dir> --workspace <dir>   … <topic_dir>/canvas.json を書く
      <dir> は CanvCode のワークスペースのフォルダ（MCP の list_documents が返す workspace）。
      <topic_dir> はその中に置く（原文のファイルを、ワークスペースの中のパスで指すため）

canvas.json の形: {"label": "...", "ops": [...]}。ops はそのまま edit_canvas に渡す（canvas_id は並べる先の Canvas）。
"""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

# 列の幅と間隔、列の上端（その上に題・問い・止めた理由を置く）
COL_W = 360
COL_GAP = 80
TOP = 260
# 原文のカードの高さ（中身に合わせると、字幕などで長くなりすぎる）
CARD_H = 420
PORTAL_W, PORTAL_H = 240, 320
GAP = 24
# edit_canvas が 1 回で受け付ける操作の数
MAX_OPS = 500
STATUS_COLORS = {"付いた": "#d3f9d8", "一部だけ": "#fff3bf", "付かなかった": "#ffe3e3"}
QUOTE_COLOR = "#f8f9fa"
DISAGREE_COLOR = "#e5dbff"
UNREACHED_COLOR = "#f1f3f5"
ARROW_COLOR = "#868e96"


def load_report():
    """照合は report.py の verify をそのまま使う（照らし方が2つに分かれないように）。"""
    spec = importlib.util.spec_from_file_location("imozuru_report", Path(__file__).with_name("report.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page_of(path: Path, line: int) -> int | None:
    """pdftotext の .txt の行が何ページ目か（ページの区切りは \\f）。PDF の .txt でなければ None。"""
    if path.suffix != ".txt" or not path.with_suffix(".pdf").is_file():
        return None
    lines = path.read_text(encoding="utf-8", errors="replace").split("\n")
    return 1 + "\n".join(lines[:line]).count("\f")


def quote_text(q: dict, page: int | None) -> str:
    loc = f"{q['file']}:{q['line']}" + (f"-{q['end']}" if q.get("end") else "") + (f"（p.{page}）" if page else "")
    lines = []
    if q.get("who"):
        lines.append(q["who"])
    if q.get("mark"):
        lines.append(q["mark"])
    lines.append(f"「{q['text']}」")
    if q.get("ja"):
        lines.append(f"訳: {q['ja']}")
    lines.append(f"— {loc}")
    if q.get("context_note"):
        lines.append(q["context_note"])
    return "\n".join(lines)


def build(topic: Path, workspace: Path) -> tuple[list[dict], list[str]]:
    """ops と、照合に通らなかった抜き書きの一覧を返す。"""
    report = load_report()
    data = json.loads((topic / "extracts.json").read_text(encoding="utf-8"))
    src = topic / "sources"
    root = workspace.resolve()

    def rel(path: Path) -> str:
        try:
            return path.resolve().relative_to(root).as_posix()
        except ValueError:
            raise SystemExit(f"{path} がワークスペース（{root}）の中にない。<topic_dir> をワークスペースの中に置く")

    groups = [(c, "claim") for c in data["claims"]] + [(d, "dis") for d in data.get("disagreements", [])]
    bad = []
    for g, _ in groups:
        for q in g.get("quotes", []):
            if not report.verify(src, q)[0]:
                bad.append(f"{q['file']}:{q['line']}  「{q['text'][:40]}…」")
    if bad:
        return [], bad

    ops: list[dict] = [
        {"op": "create", "type": "text", "as": "title", "text": data["title"], "fontSize": 28, "x": 0, "y": 0, "w": 1200},
        {"op": "create", "type": "text", "text": f"問い: {data['question']}\n止めた理由: {data['stopped']}\n"
         "付箋の「」の中は原文をそのまま切り出したもの（機械で照合済み）。要約はしていない。",
         "fontSize": 16, "place": {"below": "$title", "gap": GAP}, "w": 1200},
    ]
    sources: dict[Path, str] = {}
    arrows: list[tuple[str, str]] = []

    def column(x: int, head: str, color: str, quotes: list[dict], key: str) -> None:
        ops.append({"op": "create", "type": "note", "as": key, "text": head, "color": color, "x": x, "y": TOP, "w": COL_W})
        prev = key
        for j, q in enumerate(quotes):
            path = (src / q["file"]).resolve()
            ref = f"{key}q{j}"
            ops.append({"op": "create", "type": "note", "as": ref, "text": quote_text(q, page_of(path, q["line"])),
                        "color": QUOTE_COLOR, "place": {"below": f"${prev}", "gap": GAP}, "w": COL_W})
            sources.setdefault(path, f"s{len(sources)}")
            arrows.append((ref, sources[path]))
            prev = ref

    x = 0
    for i, c in enumerate(data["claims"]):
        head = f"{c['claim']}\n［{c['status']}］" + (f"\n{c['note']}" if c.get("note") else "")
        column(x, head, STATUS_COLORS.get(c["status"], QUOTE_COLOR), c.get("quotes", []), f"c{i}")
        x += COL_W + COL_GAP
    for i, d in enumerate(data.get("disagreements", [])):
        column(x, f"食い違い: {d['topic']}\nどれが正しいかは書かない。並べるだけ。", DISAGREE_COLOR, d.get("quotes", []), f"d{i}")
        x += COL_W + COL_GAP
    if data.get("unreached"):
        ops.append({"op": "create", "type": "note", "text": "届かなかったもの\n" + "\n".join(f"・{u}" for u in data["unreached"]),
                    "color": UNREACHED_COLOR, "x": x, "y": TOP, "w": COL_W})
        x += COL_W + COL_GAP

    # 原文の列：map.md・log.md のカード、抜き書きに出てきた順の原文（PDF は Portal、Markdown はカード）
    ops.append({"op": "create", "type": "text", "as": "src", "text": "原文（sources/）と map.md・log.md", "fontSize": 18, "x": x, "y": TOP, "w": COL_W})
    prev = "src"
    for name in ("map.md", "log.md"):
        if (topic / name).is_file():
            ops.append({"op": "create", "type": "card", "as": name.split(".")[0], "path": rel(topic / name),
                        "place": {"below": f"${prev}", "gap": GAP}, "w": COL_W, "h": CARD_H})
            prev = name.split(".")[0]
    for path, ref in sources.items():
        pdf = path.with_suffix(".pdf")
        if path.suffix == ".txt" and pdf.is_file():
            op = {"op": "create", "type": "pdf", "as": ref, "path": rel(pdf), "name": pdf.stem, "w": PORTAL_W, "h": PORTAL_H}
        elif path.suffix in (".md", ".markdown"):
            op = {"op": "create", "type": "card", "as": ref, "path": rel(path), "w": COL_W, "h": CARD_H}
        else:
            # CanvCode で開けない種類（PDF の無い .txt など）は、場所だけを書く
            op = {"op": "create", "type": "note", "as": ref, "text": f"sources/{path.name}", "color": QUOTE_COLOR, "w": COL_W}
        ops.append({**op, "place": {"below": f"${prev}", "gap": GAP}})
        prev = ref
    for frm, to in arrows:
        ops.append({"op": "connect", "from": f"${frm}", "to": f"${to}", "color": ARROW_COLOR, "dash": "dashed"})
    return ops, []


def main() -> int:
    parser = argparse.ArgumentParser(description="extracts.json を CanvCode の edit_canvas の ops（canvas.json）にする")
    parser.add_argument("topic_dir", type=Path)
    parser.add_argument("--workspace", type=Path, required=True, help="CanvCode のワークスペースのフォルダ（list_documents の workspace）")
    args = parser.parse_args()
    topic = args.topic_dir.expanduser()
    data = json.loads((topic / "extracts.json").read_text(encoding="utf-8"))
    ops, bad = build(topic, args.workspace.expanduser())
    if bad:
        print("原文に見つからない抜き書きがある（言い換えか、行番号のずれ）:")
        print("\n".join("  " + b for b in bad))
        return 1
    if len(ops) > MAX_OPS:
        print(f"操作が {len(ops)} 個あり、edit_canvas の上限 {MAX_OPS} を超える。抜き書きを減らすか、主張を分けて Canvas を2つにする")
        return 1
    out = topic / "canvas.json"
    out.write_text(json.dumps({"label": f"imozuru: {data['title']}"[:80], "ops": ops}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"照合 OK・操作 {len(ops)} 個 → {out}")
    return 0


if __name__ == "__main__":
    # 端末の文字コードに無い字（cp932 の à など）で落ちないようにする
    sys.stdout.reconfigure(errors="replace")
    sys.exit(main())
