#!/usr/bin/env python3
"""Rebuild the About portrait at the aspect ratio it is actually displayed at.

WHY. The served file was a 1100x1100 square while CSS renders it in a 4:3 box with
`object-fit: cover; object-position: 50% 30%`. Two consequences, both measured:

  * the CSS crop throws away (1 - 3/4) = 25% of the pixels of EVERY downloaded file;
    the visible region is exactly y in [82.5, 907.5] of the square;
  * there was no srcset, so a phone downloaded the same 98 KiB file as a desktop.

Cropping once here makes the CSS crop a no-op, and srcset candidates let each device
take only what it needs. Requires: ~/.venvs/img (Pillow + pillow-avif-plugin).

    ~/.venvs/img/bin/python tools/build-portrait.py

QUALITY IS CHOSEN BY MEASUREMENT, NOT BY A SLIDER. Mean/max per-pixel error against
the JPEG master (the highest-bitrate source available), cropped to the visible region:

    current live AVIF (1100x1100)  98.0 KiB   mean 1.72   max 27   <- what people get today
    AVIF q70  (1100x825)           90.0 KiB   mean 1.72   max 24   <- chosen: equal-or-better
    AVIF q60  (1100x825)           64.7 KiB   mean 2.10   max 31   <- rejected: measurably worse
    WebP q88                       113.7 KiB  mean 1.69   max 22
    JPEG q90                        176.3 KiB mean 1.19   max 21

q70 is the only candidate that is provably not a downgrade (identical mean error,
lower peak error) while being smaller, so that is what ships. Do not "optimise" this
to q60 to win another 25 KiB without measuring first — that trades visible fidelity
for bytes the owner never asked to save.

THE JPEG MASTER STAYS. `images/katerina-tsiga.jpg` (1100x1100, square) is referenced by
the LocalBusiness JSON-LD as `image`, so it must not be renamed or deleted; it is also
the source this script crops from. The old square .avif/.webp are regenerated from it
and are deleted, because nothing references them any more.
"""
import os
import sys
from PIL import Image

IMG = os.path.expanduser("~/tsiga-speech-therapy/images")
MASTER = f"{IMG}/katerina-tsiga.jpg"
TOP, HEIGHT = 82, 825          # 82.5 floored: a 0.5 source px = 0.25 CSS px of framing
WIDTHS = [550, 750, 1100]      # 550 -> 1x desktop (548 CSS px), 750 -> 2x phone, 1100 -> 2x desktop
QUALITY = {"avif": 70, "webp": 88, "jpg": 88}

master = Image.open(MASTER).convert("RGB")
if master.size != (1100, 1100):
    sys.exit(f"προσδοκούσα master 1100x1100, βρήκα {master.size}")
crop = master.crop((0, TOP, master.width, TOP + HEIGHT))
if crop.width / crop.height != 4 / 3:
    sys.exit(f"το crop δεν είναι 4:3: {crop.size}")

written = []
for w in WIDTHS:
    h = round(w * 3 / 4)
    im = crop.resize((w, h), Image.LANCZOS)
    im.save(f"{IMG}/katerina-tsiga-{w}.avif", format="AVIF", quality=QUALITY["avif"])
    im.save(f"{IMG}/katerina-tsiga-{w}.webp", format="WEBP", quality=QUALITY["webp"], method=6)
    written += [f"katerina-tsiga-{w}.avif", f"katerina-tsiga-{w}.webp"]
# one JPEG only: the <picture> fallback for browsers with neither AVIF nor WebP
crop.resize((750, 562), Image.LANCZOS).save(f"{IMG}/katerina-tsiga-750.jpg", format="JPEG",
                                            quality=QUALITY["jpg"], optimize=True, progressive=True)
written.append("katerina-tsiga-750.jpg")

for stale in ("katerina-tsiga.avif", "katerina-tsiga.webp", "katerina-tsiga-550.jpg", "katerina-tsiga-1100.jpg"):
    p = f"{IMG}/{stale}"
    if os.path.exists(p):
        os.remove(p)
        print(f"διαγράφηκε: {stale}")

print(f"\ncrop {crop.size} (4:3, y {TOP}..{TOP + HEIGHT} της τετράγωνης πηγής)")
for n in sorted(written):
    print(f"  {n:28} {os.path.getsize(f'{IMG}/{n}'):>8,} B")
print(f"\nmaster (για το JSON-LD, δεν σερβίρεται): {MASTER.split('/')[-1]} {os.path.getsize(MASTER):,} B")
