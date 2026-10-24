"""Side-by-side sheet: the owner's realism reference next to CHE's test still, with light film grain on CHE's
image (the grain is a post step for the test still only).
Usage: python3 compare.py OUT.png REF.png "ref label" CHE.png "che label" [CHE2.png "label2" ...] [--title T]
"""
import random
import sys

from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
title = ''
if '--title' in args:
    i = args.index('--title'); title = args[i + 1]; del args[i:i + 2]
out, pairs = args[0], list(zip(args[1::2], args[2::2]))
H = 520
tiles = []
for k, (path, label) in enumerate(pairs):
    im = Image.open(path).convert('RGB')
    im = im.resize((int(im.width * H / im.height), H))
    if k > 0:  # film grain on CHE's stills
        rnd = random.Random(7)
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                n = int(rnd.gauss(0, 4))
                r, g, b = px[x, y]
                px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    tiles.append((im, label))
font = ImageFont.load_default(size=18) if hasattr(ImageFont, 'load_default') else None
top = 40 if title else 10
W = sum(t.width for t, _ in tiles) + 10 * (len(tiles) + 1)
sheet = Image.new('RGB', (W, H + top + 40), (22, 22, 26))
d = ImageDraw.Draw(sheet)
if title:
    d.text((10, 10), title, fill=(235, 235, 235), font=font)
x = 10
for im, label in tiles:
    sheet.paste(im, (x, top)); d.text((x, top + H + 10), label, fill=(220, 220, 220), font=font); x += im.width + 10
sheet.save(out)
print('WROTE', out, sheet.size)
