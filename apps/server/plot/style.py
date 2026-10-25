"""CanvCode のグラフのスタイル（CSV から作るグラフ。apps/server/plot/plot.py が読む）。

ワークスペースのフォルダの直下に style.py があれば、そちらを使う（なければ、初めてグラフを作るときにこのファイルを写す）。
写したあとは CanvCode の画面（Python のカード・全画面のエディタ）や Neovim で直してよい。直したら、グラフの「描き直す」で反映する。

STYLES の 1 つが 1 つのスタイル。キーがスタイルの名前（画面の一覧と AI に出る）。値は次の項目を持つ辞書：

- description：一覧に出す短い説明（AI がスタイルを選ぶときにも読む）
- base：先に当てる matplotlib の組み込みのスタイルの名前（例 "ggplot"、"seaborn-v0_8-whitegrid"）。なくてよい
- colors：系列の色の並び（#rrggbb）。足りなければ最初に戻る
- rc：matplotlib の rcParams（https://matplotlib.org/stable/users/explain/customizing.html）
- after：描いたあとに呼ぶ関数 after(fig, ax)。rcParams でできないことをする。なくてよい

font.sans-serif・font.serif に並べたフォントのうち、入っていないものは plot.py が外す（警告を出さないため）。
日本語を出すには、日本語のフォント（Noto Sans CJK JP・IPAexGothic など）がサーバーに入っている必要がある
（Ubuntu なら sudo apt install fonts-noto-cjk）。
"""

# 日本語のフォントの候補（前にあるものから使う）。入っていない名前は無視される
JAPANESE_SANS = [
    "Noto Sans CJK JP",
    "Noto Sans JP",
    "IPAexGothic",
    "IPAGothic",
    "IPAPGothic",
    "M+ 1p",
    "Hiragino Sans",
    "Yu Gothic",
    "Meiryo",
    "DejaVu Sans",
]
JAPANESE_SERIF = [
    "Noto Serif CJK JP",
    "Noto Serif JP",
    "IPAexMincho",
    "IPAMincho",
    "Hiragino Mincho ProN",
    "Yu Mincho",
    "DejaVu Serif",
    # 明朝体がなければ、日本語の字はゴシック体で出す（matplotlib は字ごとに次のフォントを探す）
    *JAPANESE_SANS,
]

# CanvCode の円グラフと同じ色の並び（packages/nodes/src/chart.ts の CHART_COLORS）
CANVCODE_COLORS = ["#1971c2", "#f08c00", "#2f9e44", "#e03131", "#3b5bdb", "#1f2328", "#868e96"]

# どのスタイルにも共通の土台
COMMON = {
    "font.family": "sans-serif",
    "font.sans-serif": JAPANESE_SANS,
    "font.serif": JAPANESE_SERIF,
    # 日本語のフォントでマイナス記号が豆腐にならないように
    "axes.unicode_minus": False,
    "figure.facecolor": "white",
    "savefig.facecolor": "white",
}


def _hide_top_right(fig, ax):
    # 上と右の枠線を消す（rcParams の axes.spines.* は円グラフの軸にも効くので、ここで消す）
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


STYLES = {
    "標準": {
        "description": "CanvCode の色。薄い横の目盛り線、上と右の枠なし。迷ったらこれ",
        "colors": CANVCODE_COLORS,
        "rc": {
            **COMMON,
            "font.size": 11,
            "axes.titlesize": 14,
            "axes.titleweight": "bold",
            "axes.titlelocation": "left",
            "axes.edgecolor": "#adb5bd",
            "axes.labelcolor": "#495057",
            "axes.grid": True,
            "axes.grid.axis": "y",
            "grid.color": "#e9ecef",
            "grid.linewidth": 0.8,
            "axes.axisbelow": True,
            "xtick.color": "#495057",
            "ytick.color": "#495057",
            "lines.linewidth": 2.2,
            "lines.markersize": 5,
            "legend.frameon": False,
        },
        "after": _hide_top_right,
    },
    "スライド": {
        "description": "大きい文字と太い線。スライドに貼る図向け",
        "colors": CANVCODE_COLORS,
        "rc": {
            **COMMON,
            "font.size": 16,
            "axes.titlesize": 22,
            "axes.titleweight": "bold",
            "axes.titlelocation": "left",
            "axes.labelsize": 16,
            "axes.edgecolor": "#495057",
            "axes.linewidth": 1.4,
            "axes.grid": True,
            "axes.grid.axis": "y",
            "grid.color": "#dee2e6",
            "grid.linewidth": 1.0,
            "axes.axisbelow": True,
            "xtick.labelsize": 14,
            "ytick.labelsize": 14,
            "lines.linewidth": 3.5,
            "lines.markersize": 8,
            "legend.frameon": False,
            "legend.fontsize": 14,
        },
        "after": _hide_top_right,
    },
    "論文": {
        "description": "白黒と灰の明朝体。目盛りは内向き、枠は四方。論文・報告書向け",
        "colors": ["#000000", "#555555", "#999999", "#222222", "#777777"],
        "rc": {
            **COMMON,
            "font.family": "serif",
            "font.size": 10,
            "axes.titlesize": 11,
            "axes.linewidth": 0.8,
            "axes.grid": False,
            "xtick.direction": "in",
            "ytick.direction": "in",
            "xtick.top": True,
            "ytick.right": True,
            "lines.linewidth": 1.2,
            "lines.markersize": 4,
            "legend.frameon": True,
            "legend.edgecolor": "#000000",
            "legend.fancybox": False,
            "patch.edgecolor": "#000000",
            "patch.force_edgecolor": True,
        },
    },
    "ダーク": {
        "description": "暗い背景に明るい色。画面で見せる図向け",
        "colors": ["#4dabf7", "#ffa94d", "#69db7c", "#ff8787", "#9775fa", "#f8f9fa", "#adb5bd"],
        "rc": {
            **COMMON,
            "font.size": 11,
            "axes.titlesize": 14,
            "axes.titleweight": "bold",
            "axes.titlelocation": "left",
            "figure.facecolor": "#1f2328",
            "savefig.facecolor": "#1f2328",
            "axes.facecolor": "#1f2328",
            "axes.edgecolor": "#495057",
            "axes.labelcolor": "#dee2e6",
            "text.color": "#f1f3f5",
            "xtick.color": "#ced4da",
            "ytick.color": "#ced4da",
            "axes.grid": True,
            "axes.grid.axis": "y",
            "grid.color": "#343a40",
            "axes.axisbelow": True,
            "lines.linewidth": 2.2,
            "legend.frameon": False,
        },
        "after": _hide_top_right,
    },
}
