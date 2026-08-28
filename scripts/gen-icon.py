#!/usr/bin/env python3
"""生成 aTerm 应用图标源图（1024×1024 PNG）。

设计：一个对话气泡，内部挖空出 >_< ——既是终端提示符，也是一张笑脸。
配色限定深底 + 强调蓝两色，与默认主题一致。

用法:
    python3 scripts/gen-icon.py            # 写入 src-tauri/icons/icon-source.png
    npx tauri icon src-tauri/icons/icon-source.png   # 再由此生成全平台图标

依赖: Pillow
"""
import pathlib
from PIL import Image, ImageDraw

SIZE = 1024          # 源图边长
MARGIN = 96          # 圆角方块到画布的留白
RADIUS = 230         # 圆角半径（贴近 macOS squircle）
BG = (26, 27, 38, 255)      # 深底，取自默认主题背景
ACCENT = (122, 162, 247, 255)  # 强调蓝

OUT = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "icon-source.png"


def chevron(draw, x, y, size, width, color, facing=1):
    """画一个 V 形折线。facing=1 朝右（>），-1 朝左（<）。"""
    draw.line(
        [(x, y - size), (x + size * 0.78 * facing, y), (x, y + size)],
        fill=color, width=width, joint="curve",
    )


def render():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], radius=RADIUS, fill=BG)

    # 对话气泡：宽度需容纳三个符号
    d.rounded_rectangle([170, 285, 854, 650], radius=112, fill=ACCENT)
    d.polygon([(300, 640), (300, 800), (415, 645)], fill=ACCENT)  # 气泡尾巴

    # 气泡内挖空的 >_< ：两只眯眼加一张嘴
    chevron(d, 300, 455, 74, 40, BG, facing=1)
    d.rounded_rectangle([452, 528, 572, 570], radius=21, fill=BG)
    chevron(d, 724, 455, 74, 40, BG, facing=-1)

    return img


if __name__ == "__main__":
    render().save(OUT)
    print(f"已生成 {OUT}")
