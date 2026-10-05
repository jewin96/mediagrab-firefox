"""Composes the raw popup captures from make-screenshots.js onto 1280x800 canvases (store/screenshots/).
Usage: python tests/compose-screenshots.py <TEST_TMP folder that holds shots.json>"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFilter

tmp = sys.argv[1]
out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store", "screenshots")
os.makedirs(out_dir, exist_ok=True)
shots = json.load(open(os.path.join(tmp, "shots.json")))


def background():
    im = Image.new("RGB", (1280, 800)); px = im.load()
    for y in range(800):
        for x in range(1280):
            t = x / 1280 * 0.5 + y / 800 * 0.5
            px[x, y] = (int(24 + 30 * t), int(20 + 14 * t), int(44 + 50 * t))
    return im


for s in shots:
    src = Image.open(os.path.join(tmp, s["file"])).convert("RGB")
    h = min(s["h"] + 6, src.height)
    pop = src.crop((0, 0, 490, h))
    scale = 1.7 if h <= 460 else 1.5
    pop = pop.resize((int(490 * scale), int(h * scale)), Image.LANCZOS)
    canvas = background()
    x, y = (1280 - pop.width) // 2, (800 - pop.height) // 2
    shadow = Image.new("RGBA", (pop.width + 80, pop.height + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([40, 48, pop.width + 40, pop.height + 48], 20, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas.paste(shadow, (x - 40, y - 40), shadow)
    mask = Image.new("L", pop.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, pop.width, pop.height], 16, fill=255)
    canvas.paste(pop, (x, y), mask)
    canvas.save(os.path.join(out_dir, s["out"]))
    print(s["out"], canvas.size)
