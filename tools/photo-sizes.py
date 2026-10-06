"""photo-sizes.py: makes the smaller copies of the shop's own product photos (frontend/images/).

For every product photo in frontend/images/ (the ones api/src/db/seed-catalogue.json uses;
the pages' own banners and artwork are left alone), writes frontend/images/sized/<name>-400.webp, -800.webp and
-1200.webp: the whole picture, never cropped (the browser crops, with the admin's setting),
just fewer pixels. A photo narrower than a size is copied at its own width: never enlarged.
Pages then offer all three in srcset and the browser downloads the one the frame needs.

Only the 21 original photos live here. Photos uploaded in the admin are on Cloudinary, which
makes any size on request from the address (w_400…), so they need nothing from this script.

Run it again only if a photo in frontend/images/ is added or replaced:
    pip install pillow            (once)
    python tools/photo-sizes.py   (from C:\\dev\\nura)
"""
import json
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / 'frontend' / 'images'
OUT = ROOT / 'sized'
WIDTHS = (400, 800, 1200)
catalogue = json.loads((REPO / 'api' / 'src' / 'db' / 'seed-catalogue.json').read_text(encoding='utf-8'))['products']
photos = sorted({p['imageUrl'].removeprefix('images/') for p in catalogue if p['imageUrl'].startswith('images/')})

OUT.mkdir(exist_ok=True)
for src in (ROOT / name for name in photos):
    with Image.open(src) as im:
        im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB')
        for w in WIDTHS:
            width = min(w, im.width)
            h = round(im.height * width / im.width)
            out = OUT / f'{src.stem}-{w}.webp'
            im.resize((width, h), Image.LANCZOS).save(out, 'WEBP', quality=80, method=6)
    print(f'{src.name}: {im.width}x{im.height} -> ' + ', '.join(f'{src.stem}-{w}.webp' for w in WIDTHS))
