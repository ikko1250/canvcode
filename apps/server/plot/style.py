"""グラフの共通スタイル設定（CanvCode の CSV から作るグラフ。apps/server/plot/plot.py が読む）。

ワークスペースのフォルダの直下に style.py があれば、そちらを使う（なければ、初めてグラフを作るときにこのファイルを写す）。
写したあとは CanvCode の画面（Python のカード・全画面のエディタ）や Neovim で直してよい。直したら、グラフの「描き直す」で反映する。
seaborn が要る（pip install seaborn）。

set_presentation_style と place_legend は、ノートブックなどからも同じように使える：

    from style import set_presentation_style, place_legend
    set_presentation_style()
    ax = sns.lineplot(...)
    place_legend(ax, ncol=3)

CanvCode は STYLES を読む。キーがスタイルの名前（画面の一覧と AI に出る）で、値は次の項目を持つ辞書：

- description：一覧に出す短い説明（AI がスタイルを選ぶときにも読む）
- setup：描く前に呼ぶ関数（引数なし）。rcParams を整える
- legend：凡例を置く関数 legend(ax, ncol)。CanvCode が ax.legend() を呼んだあとに呼ぶ（ncol は系列の数から決める。4 まで）
- size：新しく作るときの画像の大きさ（画素の (幅, 高さ)。画面と AI がこの大きさから始める）
- colors：一覧に出す系列の色（#rrggbb）
- ほかに rc（rcParams の辞書）・base（matplotlib の組み込みのスタイル）・after（描いたあとに呼ぶ関数 after(fig, ax)）も使える

画像の大きさと解像度は CanvCode が決める（figure.figsize・figure.dpi・savefig.dpi は、画面で選んだ大きさで上書きされる）。
font_family に並べたフォントのうち、入っていないものは使わない。日本語を出すには、日本語のフォントがサーバーに入っている必要がある
（Ubuntu なら sudo apt install fonts-noto-cjk）。
"""

import seaborn as sns

# 日本語のフォントの候補（前にあるものから使う。字ごとに、前のフォントにない字は次のフォントで出す）
JAPANESE_FONTS = [
    "Noto Sans CJK JP",
    "Noto Sans JP",
    "IPAexGothic",
    "IPAGothic",
    "Hiragino Sans",
    "Yu Gothic",
    "Meiryo",
    "DejaVu Sans",
]

# 凡例の配置設定 (set_presentation_style で更新)。set_presentation_style を呼ぶ前の既定も同じ（図の下端・中央。軸の名前の下）
_legend_style = {"loc": "outside lower center", "bbox_to_anchor": None}

# 文字の大きさ (font_scale 倍する)
_FONT_SIZES = {
    "axes.titlesize": 22,
    "axes.labelsize": 18,
    "xtick.labelsize": 15,
    "ytick.labelsize": 15,
    "legend.fontsize": 14,
    "legend.title_fontsize": 15,
}


def set_presentation_style(
    font_family=JAPANESE_FONTS,
    context="talk",
    font_scale=1.15,
    legend_loc="outside lower center",
    legend_bbox_to_anchor=None,
    palette="colorblind",
):
    # 凡例: "outside ..." なら図の外側 (place_legend が図の凡例にする)。ほかは軸の凡例のまま、bbox_to_anchor の点に loc の位置を合わせる
    _legend_style.update(
        loc=legend_loc,
        bbox_to_anchor=legend_bbox_to_anchor,
    )

    # font_scale は set_theme に渡す。あとから sns.set_context を呼ぶと、下の rc の文字の大きさ・線の太さが
    # context の値で上書きされてしまうので呼ばない。文字の大きさは _FONT_SIZES を font_scale 倍する
    sns.set_theme(
        context=context,
        style="whitegrid",
        palette=palette,
        font_scale=font_scale,
        rc={
            # 字ごとに次のフォントを探す（並べた名前のうち、入っているもの）
            "font.family": list(font_family) if not isinstance(font_family, str) else [font_family],
            # 日本語のフォントでマイナス記号が欠けないように
            "axes.unicode_minus": False,
            # Figure全体を1:1 (CanvCode では画面で選んだ大きさになる)
            "figure.figsize": (7.2, 7.2),
            "figure.dpi": 64,
            "figure.facecolor": "white",
            "savefig.facecolor": "white",
            # 余白を自動調整 (軸外の凡例も含めて重ならないようにする)
            "figure.constrained_layout.use": True,
            # Font sizes
            **{key: size * font_scale for key, size in _FONT_SIZES.items()},
            # Lines / markers
            "lines.linewidth": 2.4,
            "lines.markersize": 7,
            "patch.linewidth": 1.0,
            # Axes
            "axes.linewidth": 1.2,
            "axes.edgecolor": "0.2",
            "axes.labelpad": 8,
            "axes.titlepad": 12,
            # Grid
            "grid.linewidth": 0.8,
            "grid.alpha": 0.35,
            # Ticks
            "xtick.major.width": 1.0,
            "ytick.major.width": 1.0,
            "xtick.major.size": 5,
            "ytick.major.size": 5,
            # Export (savefig.pad_inches は bbox_inches="tight" で保存するときだけ効く)
            "savefig.dpi": 300,
            "savefig.pad_inches": 0.08,
        },
    )


def place_legend(ax, ncol=1, **kwargs):
    """凡例を移動する (既定は図の下端・中央)。ncol は呼出ごとに指定。凡例がなければ何もしない。"""
    legend = ax.get_legend()
    if legend is None:
        return
    style = {**_legend_style, "ncol": ncol, **kwargs}
    if not str(style["loc"]).startswith("outside "):
        sns.move_legend(ax, **style)
        return
    # 軸の凡例を軸から決まった距離に置くと、長い目盛りの文字 (斜めにしたもの) や軸の名前と重なる。
    # 図の凡例にして図の外側に置けば、constrained layout が目盛りの文字と軸の名前の外に場所を空ける
    style.pop("bbox_to_anchor", None)
    handles, labels = legend.legend_handles, [text.get_text() for text in legend.get_texts()]
    title = legend.get_title().get_text()
    legend.remove()
    ax.figure.legend(handles, labels, title=title or None, **style)


def _palette(name):
    return sns.color_palette(name).as_hex()


STYLES = {
    "プレゼン": {
        "description": "seaborn の talk・whitegrid・colorblind。大きい文字、凡例は軸の名前の下。1:1。迷ったらこれ",
        "setup": lambda: set_presentation_style(),
        "legend": place_legend,
        "size": (1440, 1440),
        "colors": _palette("colorblind"),
    },
    "プレゼン（横長）": {
        "description": "プレゼンと同じ見た目の 16:9。スライドの横幅いっぱいに貼る図向け。凡例は軸の名前の下",
        "setup": lambda: set_presentation_style(),
        "legend": place_legend,
        "size": (1920, 1080),
        "colors": _palette("colorblind"),
    },
    "資料": {
        "description": "文字を小さめにした notebook。報告書・Markdown に貼る図向け。凡例は軸の右の外",
        "setup": lambda: set_presentation_style(context="notebook", font_scale=0.8, legend_loc="center left", legend_bbox_to_anchor=(1.02, 0.5)),
        # 右の外に置く凡例は縦に 1 列（横に並べると、軸が細くなる）
        "legend": lambda ax, ncol: place_legend(ax, ncol=1),
        "size": (1280, 800),
        "colors": _palette("colorblind"),
    },
    "白黒": {
        "description": "灰色の濃淡だけ。白黒で印刷する資料向け。凡例は軸の名前の下",
        "setup": lambda: set_presentation_style(context="notebook", font_scale=0.9, palette="gray"),
        "legend": place_legend,
        "size": (1280, 1000),
        "colors": _palette("gray"),
    },
}
