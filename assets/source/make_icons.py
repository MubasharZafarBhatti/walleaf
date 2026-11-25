"""Regenerates the Walleaf icon set. Run:  python assets/source/make_icons.py <output-folder>
then copy the PNGs (not _review.png) into assets/.

Draws the Walleaf icon set (wallet + card + centred leaf + gold clasp) with PIL.

Geometry is in a 100-unit design space (the approved preview). Everything is
rendered at 4x and downsampled for smooth edges.
"""
import math
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
SAGE = (0x44, 0x6A, 0x5A, 255)
CARD = (0xDC, 0xE7, 0xDF, 255)
BODY = (0xF7, 0xF8, 0xF4, 255)
GOLD = (0xD3, 0xA9, 0x5B, 255)
SS = 4

# Glyph bounding box in design units (card top 26, body bottom 76, body left 20, clasp right 84).
BBOX = (20, 26, 84, 76)
BCX, BCY = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2


def bezier(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        a = (1 - t) ** 3
        b = 3 * (1 - t) ** 2 * t
        c = 3 * (1 - t) * t ** 2
        d = t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


LEAF_LOCAL = bezier((10, 0), (13.5, 3), (18.5, 10), (10, 20)) + bezier((10, 20), (1.5, 10), (6.5, 3), (10, 0))[1:]


def leaf_xf(p):
    # translate(40 56) rotate(-30) scale(1.3) translate(-10 -11)
    x, y = (p[0] - 10) * 1.3, (p[1] - 11) * 1.3
    a = math.radians(-30)
    return (40 + x * math.cos(a) - y * math.sin(a), 56 + x * math.sin(a) + y * math.cos(a))


def render(size, glyph_width, center=(0.5, 0.5), bg=None, mono=False, tile=True):
    """glyph_width: fraction of the canvas the glyph bbox width occupies.
    tile=True draws the full 100-unit sage tile behind (used for icon.png)."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = glyph_width * S / (BBOX[2] - BBOX[0])  # px per design unit
    ox, oy = center[0] * S - BCX * k, center[1] * S - BCY * k

    def P(x, y):
        return (ox + x * k, oy + y * k)

    def rr(x, y, w, h, r, fill, grow=0.0):
        a, b = P(x - grow, y - grow), P(x + w + grow, y + h + grow)
        d.rounded_rectangle([a, b], radius=(r + grow) * k, fill=fill)

    def circle(cx, cy, r, fill):
        a, b = P(cx - r, cy - r), P(cx + r, cy + r)
        d.ellipse([a, b], fill=fill)

    if bg is not None:
        d.rectangle([0, 0, S, S], fill=bg)
    on = (255, 255, 255, 255)
    off = (0, 0, 0, 0)
    leaf = [P(*leaf_xf(p)) for p in LEAF_LOCAL]
    v0, v1 = leaf_xf((10, 5)), leaf_xf((10, 23))
    vw = 1.6 * 1.3

    if not mono:
        rr(26, 26, 44, 16, 6, CARD)
        rr(20, 36, 60, 40, 10, BODY)
        rr(58, 49, 26, 15, 7.5, GOLD)
        circle(66.5, 56.5, 3.2, SAGE)
        d.polygon(leaf, fill=SAGE)
        d.line([P(*v0), P(*v1)], fill=GOLD, width=max(1, round(vw * k)))
        circle(*v0, vw / 2, GOLD)
        circle(*v1, vw / 2, GOLD)
    else:
        gap = 2.6
        rr(26, 26, 44, 16, 6, on)
        rr(20, 36, 60, 40, 10, off, grow=gap)
        rr(20, 36, 60, 40, 10, on)
        rr(58, 49, 26, 15, 7.5, off, grow=gap)
        rr(58, 49, 26, 15, 7.5, on)
        circle(66.5, 56.5, 3.2, off)
        d.polygon(leaf, fill=off)
        # The vein splits the leaf cut-out in two so it still reads as a leaf.
        d.line([P(*v0), P(*v1)], fill=on, width=max(1, round(vw * 1.2 * k)))
        circle(*v1, vw * 0.6, on)
    return img.resize((size, size), Image.LANCZOS)


def tile_icon(size):
    """Full-bleed square icon (iOS/legacy/web): sage tile, glyph as in the approved preview (64 of 100 units wide)."""
    return render(size, 0.64, bg=SAGE)


tile_icon(1024).save(f'{OUT}/icon.png')
tile_icon(48).save(f'{OUT}/favicon.png')
# Adaptive icon: 108dp canvas, launcher shows the middle 72dp; 0.64 * 72/108 keeps the preview proportions
# and the farthest corner stays well inside the 66dp safe circle.
render(1024, 0.64 * 72 / 108).save(f'{OUT}/android-icon-foreground.png')
render(1024, 0.64 * 72 / 108, mono=True).save(f'{OUT}/android-icon-monochrome.png')
# Splash: glyph only, filling most of the image; app.json imageWidth sizes it on screen.
render(1024, 0.92).save(f'{OUT}/splash-icon.png')
# Notification small icon: white silhouette on transparent, 96px = 24dp at xxxhdpi.
render(96, 0.86, mono=True).save(f'{OUT}/notification-icon.png')

# Review sheet: how each asset looks under launcher masks.
sheet = Image.new('RGBA', (1400, 420), (238, 241, 234, 255))
fg = Image.open(f'{OUT}/android-icon-foreground.png').resize((324, 324), Image.LANCZOS)
def masked(shape):
    base = Image.new('RGBA', (324, 324), SAGE)
    base.alpha_composite(fg)
    crop = base.crop((54, 54, 270, 270))  # visible 72/108
    m = Image.new('L', (216, 216), 0)
    md = ImageDraw.Draw(m)
    if shape == 'circle':
        md.ellipse([0, 0, 215, 215], fill=255)
    else:
        md.rounded_rectangle([0, 0, 215, 215], radius=60, fill=255)
    crop.putalpha(m)
    return crop
sheet.alpha_composite(masked('circle'), (30, 30))
sheet.alpha_composite(masked('squircle'), (280, 30))
mono = Image.open(f'{OUT}/android-icon-monochrome.png').resize((324, 324), Image.LANCZOS).crop((54, 54, 270, 270))
mbg = Image.new('RGBA', (216, 216), (40, 60, 50, 255)); mbg.alpha_composite(mono)
mm = Image.new('L', (216, 216), 0); ImageDraw.Draw(mm).ellipse([0, 0, 215, 215], fill=255); mbg.putalpha(mm)
sheet.alpha_composite(mbg, (530, 30))
spl = Image.new('RGBA', (300, 300), SAGE)
spl.alpha_composite(Image.open(f'{OUT}/splash-icon.png').resize((150, 150), Image.LANCZOS), (75, 75))
ImageDraw.Draw(spl).ellipse([50, 50, 250, 250], outline=(255, 0, 0, 255), width=2)  # Android 12 mask (192dp of 288dp... scaled)
sheet.alpha_composite(spl.resize((216, 216)), (780, 30))
nb = Image.new('RGBA', (96, 96), (60, 60, 60, 255)); nb.alpha_composite(Image.open(f'{OUT}/notification-icon.png'))
sheet.alpha_composite(nb.resize((192, 192), Image.NEAREST), (1030, 30))
sheet.alpha_composite(Image.open(f'{OUT}/icon.png').resize((96, 96), Image.LANCZOS), (1250, 30))
sheet.alpha_composite(Image.open(f'{OUT}/favicon.png'), (1250, 150))
sheet.save(f'{OUT}/_review.png')
