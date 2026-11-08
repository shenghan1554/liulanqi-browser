"""生成浏览器图标（PNG）。仅打包/开发使用。"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "renderer", "icon.png")

SIZE = 512
SCALE = 4  # 超采样抗锯齿
W = SIZE * SCALE


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def main():
    # 对角渐变背景
    bg = Image.new("RGB", (W, W))
    px = bg.load()
    top = (0x6E, 0xA0, 0xFF)
    bottom = (0x1D, 0x3A, 0x7A)
    for y in range(W):
        for x in range(W):
            t = (x + y) / (2 * W - 2)
            px[x, y] = lerp(top, bottom, t)
    mask = rounded_mask(W, radius=int(W * 0.225))
    base = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    base.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(base)
    cx, cy = W / 2, W / 2
    r = W * 0.285
    ring = int(W * 0.052)
    white = (255, 255, 255, 255)

    # 地球/浏览器：外圈 + 横线 + 竖椭圆
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=white, width=ring)
    d.ellipse((cx - r * 0.52, cy - r, cx + r * 0.52, cy + r), outline=white, width=int(ring * 0.62))
    d.line((cx - r, cy, cx + r, cy), fill=white, width=int(ring * 0.62))
    d.line((cx, cy - r, cx, cy + r), fill=white, width=int(ring * 0.62))

    # 高光
    gloss = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse((W * 0.10, -W * 0.45, W * 0.90, W * 0.42), fill=(255, 255, 255, 36))
    base.alpha_composite(gloss)

    final = base.resize((SIZE, SIZE), Image.LANCZOS)
    final.save(OUT)
    print("icon written:", OUT, final.size)


if __name__ == "__main__":
    main()