# Contact sheet: labelled grid of renders. Usage: python3 contact_sheet.py OUT.png "label=path" "label=path" ... [--cols N] [--title T]
import sys
from PIL import Image, ImageDraw, ImageFont
args = sys.argv[1:]
out = args.pop(0)
cols = 4; title = ''
if '--cols' in args: i = args.index('--cols'); cols = int(args[i + 1]); del args[i:i + 2]
if '--title' in args: i = args.index('--title'); title = args[i + 1]; del args[i:i + 2]
cells = [a.split('=', 1) for a in args]
W = 360
ims = []
for label, path in cells:
    im = Image.open(path).convert('RGB')
    im = im.resize((W, int(im.height * W / im.width)))
    ims.append((label, im))
H = max(im.height for _, im in ims)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 18); tf = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 24)
except Exception: font = tf = ImageFont.load_default()
rows = (len(ims) + cols - 1) // cols
top = 50 if title else 10
sheet = Image.new('RGB', (cols * (W + 10) + 10, top + rows * (H + 40) + 10), (24, 26, 30))
d = ImageDraw.Draw(sheet)
if title: d.text((12, 12), title, fill=(235, 235, 235), font=tf)
for k, (label, im) in enumerate(ims):
    x = 10 + (k % cols) * (W + 10); y = top + (k // cols) * (H + 40)
    sheet.paste(im, (x, y))
    d.text((x, y + H + 8), label, fill=(220, 220, 220), font=font)
sheet.save(out)
print('WROTE', out, sheet.size)
