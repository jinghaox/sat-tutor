"""Draws the app icons into icons/. Run: python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
BLUE = (31, 79, 216)
WHITE = (255, 255, 255)


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def icon(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill=BLUE)
        scale = 0.62  # keep the artwork inside the maskable safe zone
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=BLUE)
        scale = 0.8
    cx = cy = size / 2
    d.text((cx, cy - size * 0.07 * scale), "SAT", font=font(int(size * 0.36 * scale)), fill=WHITE, anchor="mm")
    # check mark underneath
    w = size * 0.3 * scale
    y = cy + size * 0.26 * scale
    pts = [(cx - w * 0.5, y - w * 0.05), (cx - w * 0.15, y + w * 0.28), (cx + w * 0.55, y - w * 0.38)]
    d.line(pts, fill=WHITE, width=max(2, int(size * 0.045 * scale)), joint="curve")
    return img


OUT.mkdir(exist_ok=True)
icon(192).save(OUT / "icon-192.png")
icon(512).save(OUT / "icon-512.png")
icon(512, maskable=True).save(OUT / "icon-maskable-512.png")
print("icons written to", OUT)
