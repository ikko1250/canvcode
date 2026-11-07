"""CanvCode のグラフを描く（CSV の列 → PNG）。サーバー（apps/server/src/plot.ts）が子プロセスとして呼ぶ。

  python3 plot.py styles <style.py>
      スタイルの一覧を JSON（[{"name", "description", "colors", "size"?, "legend_ncol"?}]）で標準出力に書く
  python3 plot.py render <style.py> <出力の PNG>
      標準入力の JSON（下の「入力」）を描いて PNG に書き、{"width", "height", "warnings"} を標準出力に書く
      （width・height は書いた PNG の実際の画素）

入力（サーバーが CSV を読んで、列ごとの文字の並びにして渡す。数への読み替えはここで行う）：
  kind     line・bar・barh・stacked・area・scatter・pie・hist・box
  style    STYLES のキー（なければ最初のスタイル）
  x        {"name", "values"} か null（null なら行の番号 1, 2, 3…）
  series   [{"name", "values"}]（1 つ以上）
  title・xlabel・ylabel  文字（空なら出さない。xlabel・ylabel が null なら列の名前）
  legend   true・false・null（null なら系列が 2 つ以上のときだけ）
  legend_ncol  凡例の列の数（1〜20）か null（null ならスタイルの legend_ncol、それもなければ min(系列の数, 4)。MAI-95）
  width・height  画素、dpi（figsize は width / dpi・height / dpi。保存した PNG はこの大きさになる）

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
# 画面・サーバーの PLOT_MIN_SIDE と同じ
MIN_PIXELS = 150
# 棒（行 × 系列）と扇の数の上限。棒は 1 本ずつ図形になり、数千本で何十秒もかかるうえ読めない
MAX_BARS = 2000
MAX_WEDGES = 40
# 凡例の列の数の上限（画面・サーバーの normalizePlotSpec と同じ。MAI-95）
MAX_LEGEND_NCOL = 20
# 自動の列の数で凡例が収まらないとき、列の数を変えて描き直す回数の上限（自動の列の数が 4 までなら、1 列まで減らし、
# 減らしすぎて縦に収まらなければ戻すのに足りる）
MAX_LEGEND_FITS = 6
# 軸の横に置いた凡例に場所を取られて、軸の幅が図の幅のこの割合より狭くなったら、凡例が収まらないとみなす。
# 同梱のスタイルをそれぞれの大きさで描いた普通のグラフでは、軸の幅は図の幅の 0.46 以上（資料・1280×800・長い系列名の 1 列。
# 短い名前なら 0.7 以上。プレゼン・白黒は凡例が軸の下なので当てはまらない）。資料に長い系列名の 2 列を指定して軸がつぶれると
# 0.01〜0.03 になる。その間で、軸が図の 3 割より細いとグラフが読みにくいので 0.3 にする
MIN_AXES_WIDTH_RATIO = 0.3
# 軸の上・下の外に置いた凡例に場所を取られて、軸の高さが図の高さのこの割合より低くなったら、凡例が収まらないとみなす。
# 同梱のスタイルをそれぞれの大きさ（とプレゼンの 1000×1000）で、系列 10 個までの折れ線・棒を自動の列の数で描くと、軸の高さは
# 図の高さの 0.16 以上（白黒・長い系列名 10 個の 1 列）、5 個までなら 0.29 以上。凡例に場所を取られて軸がつぶれると
# 0.03〜0.11 になる（長い系列名 20 個など）。その間の 0.15 にする（列を減らして軸がつぶれるなら、減らしすぎ）
MIN_AXES_HEIGHT_RATIO = 0.15
LEGEND_TOO_WIDE = "凡例が図の幅に収まりません。列の数を減らしてください"
LEGEND_TOO_BIG = "凡例が大きく、グラフの幅が狭くなっています。列の数を減らしてください"
LEGEND_TOO_TALL = "凡例が大きく、グラフの高さが足りません。列の数を増やしてください"
LEGEND_NO_FIT = "凡例が図に収まりません。系列の名前を短くするか、系列を減らすか、画像を大きくしてください"
LEGEND_NCOL_IGNORED = "style.py の legend が凡例の列の数を決めているため、指定した {ncol} 列は効きません（legend(ax, ncol) が受け取った ncol を使うようにすると効きます）"


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
            **({"legend_ncol": style_ncol(style)} if style_ncol(style) else {}),
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
    return [max(MIN_PIXELS, min(MAX_PIXELS, width)), max(MIN_PIXELS, min(MAX_PIXELS, height))]


def legend_ncol(value):
    """凡例の列の数（1〜MAX_LEGEND_NCOL の整数）。ほかは None（MAI-95）"""
    return value if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_LEGEND_NCOL else None


def style_ncol(style):
    """style の legend_ncol（凡例の列の数の既定）。なければ・読めなければ None"""
    return legend_ncol(style.get("legend_ncol"))


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
THOUSANDS = re.compile(r"(\d),(?=\d{3}(\D|$))")


def parse_number(text):
    """数として読めれば float、空なら nan、読めなければ None。全角・桁区切りの , ・末尾の % ・円・$ は許す"""
    s = unicodedata.normalize("NFKC", str(text)).strip()
    if s == "":
        return math.nan
    s = s.replace("−", "-").replace("¥", "").replace("$", "").replace("円", "")
    if s.endswith("%"):
        s = s[:-1]
    if s.startswith("(") and s.endswith(")"):  # 会計の書き方の負の数
        s = "-" + s[1:-1]
    # 桁区切りの , は 3 桁ずつのときだけ外す（3,5 のような小数の , は数にしない。画面の parseChartNumber と同じ）
    s = THOUSANDS.sub(r"\1", s.strip())
    if not NUMBER.match(s):
        return None
    value = float(s)
    return value if math.isfinite(value) else None


# 受ける書き方は、画面の表の絞り込みの parseTableDate（packages/nodes/src/table/tableView.ts）と揃える（MAI-94）
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
    # 2026/1/5・2026-1-5 12:30（Excel が書き出す、0 で埋めない日付）
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$", s)
    if m:
        try:
            return datetime.datetime(*(int(v) for v in m.groups() if v is not None))
        except ValueError:
            return None
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
        bars = n * (1 if kind == "stacked" else len(ys))
        if bars > MAX_BARS:
            raise PlotError(f"棒が多すぎます（{bars} 本。{MAX_BARS} 本まで）。表の行を減らすか、折れ線・散布図にしてください")
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
        # tick_labels は matplotlib 3.9 から（apt の 3.6 にはない）ので、目盛りの文字はあとで付ける
        ax.boxplot(data)
        ax.set_xticks(range(1, len(names) + 1), names)
    elif kind == "pie":
        y = ys[0]
        pairs = [(labels[i] if labels else format_tick(xs[i], xkind), v) for i, v in enumerate(y) if not math.isnan(v) and v > 0]
        if not pairs:
            raise PlotError(f"列「{names[0]}」に正の値がありません（円グラフは正の値だけを扇にします）")
        if len(pairs) > MAX_WEDGES:
            # 大きい順に MAX_WEDGES - 1 個を残し、残りは「その他」にまとめる（表の順は保つ）
            keep = set(sorted(range(len(pairs)), key=lambda i: -pairs[i][1])[: MAX_WEDGES - 1])
            rest = sum(v for i, (_, v) in enumerate(pairs) if i not in keep)
            pairs = [p for i, p in enumerate(pairs) if i in keep] + [("その他", rest)]
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
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
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
            cell = str(bad[1]) if len(str(bad[1])) <= 40 else f"{str(bad[1])[:40]}…"
            warnings_out.append(f"列「{column['name']}」の {bad[0] + 1} 行目「{cell}」は数でないので飛ばしました")
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
    width = max(MIN_PIXELS, min(MAX_PIXELS, int(spec.get("width") or 1280)))
    height = max(MIN_PIXELS, min(MAX_PIXELS, int(spec.get("height") or 800)))
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
        # 円と箱ひげは凡例を描かない（系列の名前は扇・目盛りの文字に出る。箱ひげで凡例を出すと、中身のない枠になる）
        legend = spec.get("legend")
        if kind not in ("pie", "box") and (legend if legend is not None else len(series) > 1):
            notice = put_legend(fig, ax, style, len(series), legend_ncol(spec.get("legend_ncol")))
            if notice:
                warnings_out.append(notice)
        after = style.get("after")
        if callable(after):
            try:
                after(fig, ax)
            except Exception as error:
                raise PlotError(f"style.py の after でエラーになりました：{type(error).__name__}: {error}") from error
        # 頼んだ大きさの PNG にする（MAI-95）。rc の savefig.bbox が "tight" だと図の外の文字まで広げて大きさが変わり
        # （bbox_inches=None でも rc の値になる）、after が大きさを変えることもあるので、保存の直前に戻す
        plt.rcParams["savefig.bbox"] = "standard"
        fig.set_size_inches(width / dpi, height / dpi)
        fig.set_dpi(dpi)
        fig.savefig(out_path, format="png", dpi=dpi)
    plt.close(fig)
    if any("Glyph" in str(w.message) and "missing" in str(w.message) for w in caught) or (not has_cjk_font() and text_has_cjk(spec)):
        warnings_out.append("日本語のフォントが見つからないため、文字が欠けているかもしれません（Ubuntu なら sudo apt install fonts-noto-cjk）")
    # 返す大きさは、書いた PNG の実際の画素（小数の丸めで 1 画素ずれても、画面・Asset と食い違わない）
    actual_width, actual_height = png_size(out_path)
    return {"width": actual_width, "height": actual_height, "warnings": warnings_out}


def png_size(path):
    """PNG の IHDR の幅と高さ"""
    with open(path, "rb") as f:
        head = f.read(24)
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def put_legend(fig, ax, style, count, asked):
    """凡例を置き、知らせの文を返す（なければ None）（MAI-95）。
    列の数は、グラフの指定（asked）→ スタイルの legend_ncol → min(系列の数, 4)。ただし style.py に legend の関数も
    legend_ncol もなければ、matplotlib の既定と同じ 1 列（今までどおり ax.legend() に ncol を渡さない）にし、それより増やさない。
    指定がなければ、凡例が収まらない（measure_legend）ときは列を減らして試し、収まったもの（なければいちばん収まりに近いもの）を残す。
    指定したときは減らさず、収まらないときと、style.py の legend が列の数を変えたときに知らせる"""
    default = style_ncol(style)
    ncol = asked or default or (min(count, 4) if callable(style.get("legend")) else 1)
    pass_ncol = asked is not None or default is not None
    before = list(fig.legends)
    make_legend(fig, ax, style, ncol, pass_ncol)
    fit = measure_legend(fig, ax, before)
    if fit is None:
        return None
    if asked is not None:
        if fit["ncol"] is not None and fit["ncol"] != asked:
            # 決め打ちの列の数で描かれた。「列の数を減らしてください」は当てはまらない
            return LEGEND_NCOL_IGNORED.format(ncol=asked)
        return asked_notice(fit, asked)
    best = (fit, ncol, pass_ncol)
    tried = {ncol}
    # 横に収まらなかったいちばん少ない列の数
    too_wide = None
    for _ in range(MAX_LEGEND_FITS):
        if fit["badness"] == 0:
            break
        # 頼んだ列の数と、描いた凡例の列の数（style.py の legend が変えたかもしれない）の小さいほう
        drawn = min(ncol, fit["ncol"] or ncol)
        if fit["wide"]:
            # 少なくとも 1 列減らす。凡例の幅はおよそ列の数に比例するので、はみ出すなら収まりそうな列の数まで一度に減らす
            too_wide = drawn
            ncol = max(1, min(drawn - 1, math.floor(drawn * fig.bbox.width / fit["width"])))
        elif too_wide is not None and drawn + 1 < too_wide:
            # 縦にだけ収まらない：減らしすぎた。飛ばした列の数を 1 列ずつ増やして試す
            ncol = drawn + 1
        else:
            # 縦にだけ収まらない（列を減らすと凡例が縦に伸び、もっと悪くなる）
            break
        if ncol in tried or (fit["wide"] and drawn <= 1):
            break
        tried.add(ncol)
        remove_legends(fig, ax, before)
        make_legend(fig, ax, style, ncol, pass_ncol=True)
        fit = measure_legend(fig, ax, before)
        if fit is None:
            return None
        if fit["badness"] < best[0]["badness"]:
            best = (fit, ncol, True)
    if fit is not best[0]:
        # 試した中でいちばんよかった列の数で置き直す
        remove_legends(fig, ax, before)
        make_legend(fig, ax, style, best[1], best[2])
    return LEGEND_NO_FIT if best[0]["badness"] > 0 else None


def asked_notice(fit, asked):
    """指定した列の数で収まらないときの知らせ。横にだけ収まらなければ列を減らす、縦にだけなら増やすように言う"""
    if fit["badness"] == 0:
        return None
    if fit["wide"] and not fit["tall"] and asked > 1:
        return LEGEND_TOO_WIDE if fit["over_x"] > 0 else LEGEND_TOO_BIG
    if fit["tall"] and not fit["wide"]:
        return LEGEND_TOO_TALL
    return LEGEND_NO_FIT


def make_legend(fig, ax, style, ncol, pass_ncol):
    """軸の凡例を作り、style.py の legend(ax, ncol) で置く（列の数を変えて、何度も呼ぶことがある）"""
    if pass_ncol:
        # ncols= は matplotlib 3.6 からなので、前からある ncol= を使う
        ax.legend(ncol=ncol)
    else:
        ax.legend()
    place = style.get("legend")
    if callable(place):
        try:
            place(ax, ncol)
        except Exception as error:
            raise PlotError(f"style.py の legend でエラーになりました：{type(error).__name__}: {error}") from error


def placed_legends(fig, ax, before):
    """置いた凡例（軸の凡例と、style.py の legend が足した図の凡例）"""
    return [legend for legend in [ax.get_legend(), *fig.legends] if legend is not None and legend not in before]


def remove_legends(fig, ax, before):
    for legend in placed_legends(fig, ax, before):
        legend.remove()


def measure_legend(fig, ax, before):
    """置いた凡例を描いてみて（constrained layout が凡例と軸の場所を決める）測る。凡例がなければ None。
    収まらない量（画素。1 画素までは収まっているとみなす）を次のように測る：
    - 横（wide）：凡例が図の左右からはみ出す（over_x）。軸の左右の外の凡例（資料など）に場所を取られて、
      軸の幅が図の幅の MIN_AXES_WIDTH_RATIO より狭い
    - 縦（tall）：凡例が図の上下からはみ出す。軸の上下の外の凡例（プレゼンなど）に場所を取られて、軸の高さが図の高さの
      MIN_AXES_HEIGHT_RATIO より低い。軸の外に置くはずの図の凡例（"outside ..."）が軸に重なる
      （constrained layout が場所を空けられなかった）
    軸の中の凡例は、軸の幅も高さも取らない（軸が細いのは目盛りの文字などのせいなので、列の数を変えても変わらない）"""
    legends = placed_legends(fig, ax, before)
    if not legends:
        return None
    if hasattr(fig, "draw_without_rendering"):
        fig.draw_without_rendering()
    else:
        fig.canvas.draw()
    f, a = fig.bbox, ax.bbox
    boxes = [legend.get_window_extent() for legend in legends]
    over_x = sum(excess(f.x0 - b.x0) + excess(b.x1 - f.x1) for b in boxes)
    over_y = sum(excess(f.y0 - b.y0) + excess(b.y1 - f.y1) for b in boxes)
    beside = any(b.x0 >= a.x1 - 1 or b.x1 <= a.x0 + 1 for b in boxes)
    stacked = any(b.y0 >= a.y1 - 1 or b.y1 <= a.y0 + 1 for b in boxes)
    narrow = excess(f.width * MIN_AXES_WIDTH_RATIO - a.width) if beside else 0
    short = excess(f.height * MIN_AXES_HEIGHT_RATIO - a.height) if stacked else 0
    covered = sum(overlap(b, a) for legend, b in zip(legends, boxes) if getattr(legend, "_outside_loc", None))
    # 描いた凡例の列の数（matplotlib 3.6 から _ncols、その前は _ncol）
    ncols = [getattr(legend, "_ncols", getattr(legend, "_ncol", None)) for legend in legends]
    ncols = [n for n in ncols if isinstance(n, int)]
    return {
        "ncol": max(ncols) if ncols else None,
        "width": max(b.width for b in boxes),
        "over_x": over_x,
        "wide": over_x + narrow > 0,
        "tall": over_y + short + covered > 0,
        "badness": over_x + narrow + over_y + short + covered,
    }


def excess(pixels):
    """1 画素を超える分（はみ出し・足りない量）。1 画素までは 0"""
    return pixels if pixels > 1 else 0


def overlap(b, a):
    """2 つの外枠の重なりの深さ（重なった範囲の幅と高さの小さいほう）"""
    width = min(b.x1, a.x1) - max(b.x0, a.x0)
    height = min(b.y1, a.y1) - max(b.y0, a.y0)
    return excess(min(width, height)) if width > 0 and height > 0 else 0


def text_has_cjk(spec):
    texts = [spec.get("title") or "", spec.get("xlabel") or "", spec.get("ylabel") or ""]
    x = spec.get("x")
    if x:
        texts.append(str(x["name"]))
        texts.extend(str(v) for v in x["values"][:200])
    texts.extend(str(s["name"]) for s in spec.get("series") or [])
    return any(ord(ch) > 0x2E7F for t in texts for ch in t)


def main(argv):
    # 結果の JSON だけを本当の標準出力に書く。style.py の print などは標準エラーへ回す（混ざるとサーバーが読めない）
    out = sys.stdout
    sys.stdout = sys.stderr
    if len(argv) >= 3 and argv[1] == "styles":
        json.dump(list_styles(argv[2]), out, ensure_ascii=False)
        return 0
    if len(argv) >= 4 and argv[1] == "render":
        spec = json.load(sys.stdin)
        result = render(spec, load_styles(argv[2]), argv[3])
        json.dump(result, out, ensure_ascii=False)
        return 0
    sys.stderr.write(__doc__)
    return 64


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except PlotError as error:
        sys.stderr.write(str(error) + "\n")
        sys.exit(2)
