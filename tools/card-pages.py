"""Prints which storefront pages contain each product card, for CARD_PAGES in frontend/js/search.js.

    python tools/card-pages.py

Needed only until Phase 7, when the grids are rendered from the API instead of written by hand.
"""
import json, re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
ORDER = ["new-in.html", "sale.html", "women.html", "men.html", "index.html"]

pages = {}
for name in ORDER:
    for sku in re.findall(r'data-sku="([^"]+)"', (FRONTEND / name).read_text(encoding="utf-8")):
        pages.setdefault(sku, []).append(name)
for sku in sorted(pages):
    print(f'    "{sku}":{json.dumps(pages[sku], separators=(",", ":"))},')
