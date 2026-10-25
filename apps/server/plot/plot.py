"""CanvCode のグラフを描く（CSV の列 → PNG）。サーバー（apps/server/src/plot.ts）が子プロセスとして呼ぶ。

  python3 plot.py styles <style.py>
      スタイルの一覧を JSON（[{"name", "description", "colors", "size"?}]）で標準出力に書く
  python3 plot.py render <style.py> <出力の PNG>
      標準入力の JSON（下の「入力」）を描いて PNG に書き、{"width", "height", "warnings"} を標準出力に書く

入力（サーバーが CSV を読んで、列ごとの文字の並びにして渡す。数への読み替えはここで行う）：
  kind     line・bar・barh・stacked・area・scatter・pie・hist・box
  style    STYLES のキー（なければ最初のスタイル）
  x        {"name", "values"} か null（null なら行の番号 1, 2, 3…）
  series   [{"name", "values"}]（1 つ以上）
  title・xlabel・ylabel  文字（空なら出さない。xlabel・ylabel が null なら列の名前）
  legend   true・false・null（null なら系列が 2 つ以上のときだけ）
  width・height  画素、dpi

使う人の誤り（列が数でない・スタイルがないなど）は、メッセージを標準エラーに書いて終了コード 2。
"""

import datetime
import importlib.util
import json
import math
import re
import sys
import unicodedata
import warnings

# ワークスペースの style.py を読み込んでも、そこに __pycache__ を作らない
sys.dont_write_bytecode = True

import matplotlib  # noqa: E402

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
from cycler import cycler  # noqa: E402
from matplotlib import font_manager  # noqa: E402

KINDS = ("line", "bar", "barh", "stacked", "area", "scatter", "pie", "hist", "box")
GENERIC_FAMILIES = {"serif", "sans-serif", "monospace", "cursive", "fantasy"}
# 文字の軸の目盛りを、これより多くは出さない（間引く）
MAX_CATEGORY_TICKS = 24
# 系列の数の上限（凡例が読めなくなる）
MAX_SERIES = 20
MAX_PIXELS = 4000


class PlotError(Exception):
    pass


# ---- スタイル ----


def load_styles(path):
    spec = importlib.util.spec_from_file_location("canvcode_style", path)
    if spec is None or spec.loader is None:
        raise PlotError(f"style.py を読めません：{path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # style.py の誤りは、そのまま知らせる
        raise PlotError(f"style.py の読み込みに失敗しました：{type(error).__name__}: {error}") from error
    styles = getattr(module, "STYLES", None)
    if not isinstance(styles, dict) or not styles:
        raise PlotError("style.py に STYLES（スタイルの名前 → 設定の辞書）がありません")
    for name, style in styles.items():
        if not isinstance(style, dict):
            raise PlotError(f"style.py の STYLES[{name!r}] が辞書ではありません")
    return styles


def list_styles(path):
    styles = load_styles(path)
    return [
        {
            "name": str(name),
            "description": str(style.get("description", "")),
            "colors": [str(c) for c in style.get("colors", [])][:12],
            **({"size": style_size(style)} if style_size(style) else {}),
        }
        for name, style in styles.items()
    ]


def style_size(style):
    """style の size（画素の (幅, 高さ)）。なければ・読めなければ None"""
    size = style.get("size")
    try:
        width, height = (int(v) for v in size)
    except (TypeError, ValueError):
        return None
    return [max(150, min(MAX_PIXELS, width)), max(150, min(MAX_PIXELS, height))]


def installed_fonts():
    return {f.name for f in font_manager.fontManager.ttflist}


def apply_style(style):
    setup = style.get("setup")
    if setup is not None:
        if not callable(setup):
            raise PlotError("style.py の setup が関数ではありません")
        try:
            setup()
        except Exception as error:
            raise PlotError(f"style.py の setup でエラーになりました：{type(error).__name__}: {error}") from error
    base = style.get("base")
    if base:
        try:
            plt.style.use(base)
        except OSError as error:
            raise PlotError(f"matplotlib のスタイル {base!r} がありません") from error
    rc = dict(style.get("rc", {}))
    colors = style.get("colors")
    if colors:
        rc["axes.prop_cycle"] = cycler(color=list(colors))
    # 入っていないフォントは外す（findfont の警告を出さない）。何も残らなければ matplotlib の既定に任せる
    fonts = installed_fonts()
    for key in ("font.sans-serif", "font.serif", "font.monospace"):
        if key in rc:
            names = [rc[key]] if isinstance(rc[key], str) else list(rc[key])
            kept = [n for n in names if n in fonts]
            if kept:
                rc[key] = kept
            else:
                del rc[key]
    try:
        plt.rcParams.update(rc)
    except (KeyError, ValueError) as error:
        raise PlotError(f"style.py の rc の値が正しくありません：{error}") from error
    # font.family の serif などは、font.serif の並びの最初の 1 つにしかならず、字ごとに次のフォントを探してくれない。
    # 入っているフォントの名前に開いて並べ、欧文のフォントにない日本語の字は、次の日本語のフォントで出す
    families = []
    for name in plt.rcParams["font.family"]:
        expanded = [n for n in plt.rcParams[f"font.{name}"] if n in fonts] if name in GENERIC_FAMILIES else [name] if name in fonts else []
        families += [n for n in expanded if n not in families]
    if not families:
        # 並べたフォントがどれも入っていない：入っている sans-serif のフォントで描く
        families = [n for n in plt.rcParams["font.sans-serif"] if n in fonts] or ["DejaVu Sans"]
    plt.rcParams["font.family"] = families


# ---- 値の読み方 ----

NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")


def parse_number(text):
    """数として読めれば float、空なら nan、読めなければ None。全角・桁区切りの , ・末尾の % ・円・$ は許す"""
    s = unicodedata.normalize("NFKC", str(text)).strip()
    if s == "":
        return math.nan
    s = s.replace(",", "").replace("−", "-").replace("¥", "").replace("$", "").replace("円", "")
    if s.endswith("%"):
        s = s[:-1]
    if s.startswith("(") and s.endswith(")"):  # 会計の書き方の負の数
        s = "-" + s[1:-1]
    return float(s) if NUMBER.match(s) else None


def parse_date(text):
    s = unicodedata.normalize("NFKC", str(text)).strip()
    if s == "":
        return None
    s = s.replace("/", "-").replace(".", "-")
    m = re.match(r"^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$", s)
    if m:
        return datetime.datetime(int(m[1]), int(m[2]), int(m[3] or 1))
    m = re.match(r"^(\d{4})-(\d{1,2})$", s)
    if m:
        return datetime.datetime(int(m[1]), int(m[2]), 1)
    try:
        return datetime.datetime.fromisoformat(s)
    except ValueError:
        return None


def numeric_values(column):
    values = []
    bad = None
    for i, cell in enumerate(column["values"]):
        n = parse_number(cell)
        if n is None:
            bad = bad if bad is not None else (i, cell)
            n = math.nan
        values.append(n)
    if all(math.isnan(v) for v in values):
        raise PlotError(f"列「{column['name']}」に数がありません（数の列を選んでください）")
    return values, bad


def x_axis(x, n):
    """x の列を (値, 種類) にする。種類は number・date・category（文字の並び。値は位置 0, 1, 2…）"""
    if x is None:
        return list(range(1, n + 1)), "number", None
    cells = list(x["values"])[:n]
    filled = [c for c in cells if str(c).strip() != ""]
    if filled and all(parse_number(c) is not None for c in filled):
        return [parse_number(c) for c in cells], "number", None
    if filled and all(parse_date(c) is not None for c in filled):
        return [parse_date(c) for c in cells], "date", None
    return list(range(len(cells))), "category", [str(c) for c in cells]


# ---- 描く ----


def set_category_ticks(ax, labels, axis="x"):
    n = len(labels)
    step = max(1, math.ceil(n / MAX_CATEGORY_TICKS))
    positions = list(range(0, n, step))
    shown = [labels[i] for i in positions]
    if axis == "x":
        ax.set_xticks(positions)
        long = n > 8 or max((len(s) for s in shown), default=0) > 6
        ax.set_xticklabels(shown, rotation=45 if long else 0, ha="right" if long else "center")
    else:
        ax.set_yticks(positions)
        ax.set_yticklabels(shown)


def draw(ax, kind, xs, xkind, labels, series):
    names = [s["name"] for s in series]
    ys = [s["values"] for s in series]
    n = len(xs)
    if kind == "line":
        marker = "o" if n <= 40 else None
        for name, y in zip(names, ys):
            ax.plot(xs, y, label=name, marker=marker)
        if labels:
            set_category_ticks(ax, labels)
    elif kind == "scatter":
        for name, y in zip(names, ys):
            ax.scatter(xs, y, label=name, alpha=0.85)
        if labels:
            set_category_ticks(ax, labels)
    elif kind in ("bar", "barh", "stacked"):
        # 数・日付の軸でも、棒は行ごとに等間隔に並べ、値を目盛りの文字にする
        if labels is None:
            labels = [format_tick(v, xkind) for v in xs]
        positions = list(range(n))
        if kind == "stacked":
            bottom = [0.0] * n
            for name, y in zip(names, ys):
                heights = [0.0 if math.isnan(v) else v for v in y]
                ax.bar(positions, heights, 0.7, bottom=bottom, label=name)
                bottom = [b + h for b, h in zip(bottom, heights)]
        else:
            width = 0.8 / len(ys)
            for i, (name, y) in enumerate(zip(names, ys)):
                offset = [p - 0.4 + width * (i + 0.5) for p in positions]
                heights = [0.0 if math.isnan(v) else v for v in y]
                if kind == "bar":
                    ax.bar(offset, heights, width, label=name)
                else:
                    ax.barh(offset, heights, width, label=name)
        if kind == "barh":
            set_category_ticks(ax, labels, axis="y")
            ax.invert_yaxis()  # 表の上の行を上に
            ax.grid(False, axis="y")
            if plt.rcParams["axes.grid"]:
                ax.grid(True, axis="x")
        else:
            set_category_ticks(ax, labels)
    elif kind == "area":
        filled = [[0.0 if math.isnan(v) else v for v in y] for y in ys]
        positions = xs if labels is None else list(range(n))
        ax.stackplot(positions, *filled, labels=names, alpha=0.85)
        if labels:
            set_category_ticks(ax, labels)
    elif kind == "hist":
        multiple = len(ys) > 1
        for name, y in zip(names, ys):
            ax.hist([v for v in y if not math.isnan(v)], bins="auto", alpha=0.6 if multiple else 0.9, label=name)
    elif kind == "box":
        data = [[v for v in y if not math.isnan(v)] for y in ys]
        ax.boxplot(data, tick_labels=names)
    elif kind == "pie":
        y = ys[0]
        pairs = [(labels[i] if labels else format_tick(xs[i], xkind), v) for i, v in enumerate(y) if not math.isnan(v) and v > 0]
        if not pairs:
            raise PlotError(f"列「{names[0]}」に正の値がありません（円グラフは正の値だけを扇にします）")
        wedges, _, percents = ax.pie(
            [v for _, v in pairs],
            labels=[label for label, _ in pairs],
            autopct="%1.0f%%",
            startangle=90,
            counterclock=False,
            wedgeprops={"linewidth": 1, "edgecolor": plt.rcParams["axes.facecolor"]},
        )
        # ％の文字は、暗い扇の上では白に
        for wedge, text in zip(wedges, percents):
            r, g, b, _ = wedge.get_facecolor()
            text.set_color("white" if 0.299 * r + 0.587 * g + 0.114 * b < 0.5 else "black")
        ax.set_aspect("equal")
        ax.grid(False)


def format_tick(value, xkind):
    if xkind == "date" and isinstance(value, datetime.datetime):
        if value.hour == 0 and value.minute == 0:
            return value.strftime("%Y-%m-%d") if value.day != 1 else value.strftime("%Y-%m")
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def has_cjk_font():
    fonts = installed_fonts()
    return any(n in fonts and not n.startswith("DejaVu") for n in plt.rcParams["font.family"])


def render(spec, styles, out_path):
    kind = spec.get("kind", "line")
    if kind not in KINDS:
        raise PlotError(f"グラフの種類 {kind!r} はありません（{', '.join(KINDS)}）")
    style_name = spec.get("style") or next(iter(styles))
    if style_name not in styles:
        raise PlotError(f"スタイル「{style_name}」は style.py にありません（{'・'.join(map(str, styles))}）")
    style = styles[style_name]
    series_in = spec.get("series") or []
    if not series_in:
        raise PlotError("値の列を 1 つ以上選んでください")
    if len(series_in) > MAX_SERIES:
        raise PlotError(f"値の列は {MAX_SERIES} 個までです")
    warnings_out = []
    series = []
    for column in series_in:
        values, bad = numeric_values(column)
        if bad is not None:
            warnings_out.append(f"列「{column['name']}」の {bad[0] + 1} 行目「{bad[1]}」は数でないので飛ばしました")
        series.append({"name": str(column["name"]), "values": values})
    n = max(len(s["values"]) for s in series)
    for s in series:
        s["values"] += [math.nan] * (n - len(s["values"]))
    x = spec.get("x")
    xs, xkind, labels = x_axis(x, n)
    if kind == "pie" and len(series) > 1:
        warnings_out.append("円グラフは最初の値の列だけを描きます")
        series = series[:1]

    apply_style(style)
    width = max(200, min(MAX_PIXELS, int(spec.get("width") or 1280)))
    height = max(150, min(MAX_PIXELS, int(spec.get("height") or 800)))
    dpi = max(50, min(400, int(spec.get("dpi") or 200)))
    fig = plt.figure(figsize=(width / dpi, height / dpi), dpi=dpi, layout="constrained")
    ax = fig.add_subplot()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        draw(ax, kind, xs, xkind, labels, series)
        title = spec.get("title") or ""
        if title:
            ax.set_title(title)
        if kind not in ("pie", "box"):
            xlabel = spec.get("xlabel")
            ylabel = spec.get("ylabel")
            value_label = series[0]["name"] if len(series) == 1 else ""
            category_label = "" if x is None else str(x["name"])
            if kind == "hist":
                category_label, value_label = value_label, "度数"
            # xlabel・ylabel は見えている横・縦の軸の名前。横向きの棒は横が値、縦が項目
            if kind == "barh":
                category_label, value_label = value_label, category_label
            ax.set_xlabel(category_label if xlabel is None else xlabel)
            ax.set_ylabel(value_label if ylabel is None else ylabel)
        if xkind == "date" and kind in ("line", "scatter", "area"):
            fig.autofmt_xdate()
        legend = spec.get("legend")
        if kind != "pie" and (legend if legend is not None else len(series) > 1 and kind != "box"):
            ax.legend()
            place = style.get("legend")
            if callable(place):
                try:
                    place(ax, min(len(series), 4))
                except Exception as error:
                    raise PlotError(f"style.py の legend でエラーになりました：{type(error).__name__}: {error}") from error
        after = style.get("after")
        if callable(after):
            try:
                after(fig, ax)
            except Exception as error:
                raise PlotError(f"style.py の after でエラーになりました：{type(error).__name__}: {error}") from error
        fig.savefig(out_path, format="png", dpi=dpi)
    plt.close(fig)
    if any("Glyph" in str(w.message) and "missing" in str(w.message) for w in caught) or (not has_cjk_font() and text_has_cjk(spec)):
        warnings_out.append("日本語のフォントが見つからないため、文字が欠けているかもしれません（Ubuntu なら sudo apt install fonts-noto-cjk）")
    return {"width": width, "height": height, "warnings": warnings_out}


def text_has_cjk(spec):
    texts = [spec.get("title") or "", spec.get("xlabel") or "", spec.get("ylabel") or ""]
    x = spec.get("x")
    if x:
        texts.append(str(x["name"]))
        texts.extend(str(v) for v in x["values"][:200])
    texts.extend(str(s["name"]) for s in spec.get("series") or [])
    return any(ord(ch) > 0x2E7F for t in texts for ch in t)


def main(argv):
    if len(argv) >= 3 and argv[1] == "styles":
        json.dump(list_styles(argv[2]), sys.stdout, ensure_ascii=False)
        return 0
    if len(argv) >= 4 and argv[1] == "render":
        spec = json.load(sys.stdin)
        result = render(spec, load_styles(argv[2]), argv[3])
        json.dump(result, sys.stdout, ensure_ascii=False)
        return 0
    sys.stderr.write(__doc__)
    return 64


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except PlotError as error:
        sys.stderr.write(str(error) + "\n")
        sys.exit(2)
