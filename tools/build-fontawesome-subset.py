#!/usr/bin/env python3
"""Build the Font Awesome subset this site actually needs.

Reads the vendored, byte-identical upstream all.min.css + webfonts, and emits:
  vendor/font-awesome/6.5.1/subset/fa-subset.css
  vendor/font-awesome/6.5.1/subset/fa-solid-900.woff2   (only the used glyphs)
  vendor/font-awesome/6.5.1/subset/fa-brands-400.woff2  (only the used glyphs)

Run it after adding a new icon anywhere; then re-run the pixel gate. The upstream
full files stay in the tree as the source of truth for a rebuild.

Design notes (learned the hard way, see the site notes):
  * LINEAR parse of the CSS. Nested-quantifier regexes hang on the minified file.
  * The 5 alias traps: fa-bars, fa-home, fa-phone-alt, fa-calendar-alt, fa-check-circle
    have no `.fa-X:before` rule of their own — they are grouped with FA's FA6 aliases
    (e.g. `.fa-home-alt:before,.fa-home:before,.fa-house:before`). Match on the LAST
    class token of every selector in the group and keep the WHOLE group, so aliases
    keep working. Matching `.<name>:before` alone would blank the mobile hamburger.
  * Keep the family machinery verbatim: the base rule, the three `font-family:"Font
    Awesome…"` rules, the three bare `font-weight:` rules (they select the face), the
    :root vars and the license notice. Everything else — the size/rotate/spin/stack
    utilities and the animation keyframes — is unused here and is dropped.
  * Subset the fonts WITHOUT touching the outlines (no --no-hinting, no
    --desubroutinize): altering hinting changes rasterisation and would break the
    pixel gate. Only the cmap is trimmed.
"""
import os, re, json, subprocess, sys

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
FA = SITE + "vendor/font-awesome/6.5.1/"
PAGES = ["index.html"]          # business-card.html was removed on the owner's request
PYFT = os.path.expanduser("~/.venvs/fonts/bin/pyftsubset")
BASE_CLASSES = {"fas": "solid", "fa-solid": "solid", "far": "regular", "fa-regular": "regular",
                "fab": "brands", "fa-brands": "brands"}
FACE_FOR = {"solid": "fa-solid-900.woff2", "regular": "fa-regular-400.woff2", "brands": "fa-brands-400.woff2"}

# ---------- 1. inventory ----------
used, elements = {}, 0
for page in PAGES:
    html = open(SITE + page, encoding="utf-8").read()
    for m in re.finditer(r'<i\s+class="([^"]*)"', html):
        cls = m.group(1).split()
        if not any(c.startswith("fa") for c in cls):
            continue
        elements += 1
        base = next((BASE_CLASSES[c] for c in cls if c in BASE_CLASSES), "solid")
        glyphs = [c for c in cls if c.startswith("fa-") and c not in BASE_CLASSES]
        for g in glyphs:
            used.setdefault(g, set()).add(base)

# ---------- 2. linear CSS parse ----------
css = open(FA + "css/all.min.css", encoding="utf-8").read()
# A rule runs from its selector to its closing brace. Track the selector start
# separately: appending css[start:i+1] at BOTH the "{" and the "}" duplicates the
# selector ("Sel{A{decls}"), which is invalid CSS and silently kills the whole
# stylesheet -- every icon then renders as `content: none`.
rules, depth, start, sel_start = [], 0, 0, 0
for i, ch in enumerate(css):
    if ch == "{":
        if depth == 0:
            sel_start = start
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            rules.append(css[sel_start:i + 1])
            start = i + 1

faces, icon_rules, machinery = [], [], []
for r in rules:
    body = r[r.index("{") + 1:-1] if "{" in r else r      # strip the closing brace
    if r.startswith("@font-face"):
        faces.append(r)
    elif 'content:"\\' in body.replace(" ", ""):
        icon_rules.append(r)
    else:
        machinery.append(r)

# ---------- 3. classify ----------
def face_info(r):
    fam = re.search(r'font-family:"?([^";]+)', r)
    weight = re.search(r"font-weight:(\d+)", r)
    src = [s.split("/")[-1].split(")")[0] for s in re.findall(r"url\(([^)]+)\)", r)]
    return (fam.group(1) if fam else "?"), (weight.group(1) if weight else "?"), src

used_families = {f for g in used for f in used[g]}
keep_faces = []
for r in faces:
    fam, w, src = face_info(r)
    target = next((f for f, fn in FACE_FOR.items() if fn in src), None)
    if fam.startswith("Font Awesome 6 ") and w != "?" and target in used_families:
        # point the src at the subset file we are about to build
        r = re.sub(r"src:url\([^)]+\)[^;}]*", f'src:url({FACE_FOR[target]})', r, count=1)
        keep_faces.append(r)

def keep_machinery(r):
    # NOTE: the body must exclude the trailing "}" or the exact-match test below
    # silently fails and `.fa-solid,.fas{font-weight:900}` is dropped -- every icon
    # then renders at weight 400 from a fallback face and the pixel gate catches it.
    body = r[r.index("{") + 1:-1]
    return ("--fa-style-family" in body or "--fa-font-" in body
            or 'font-family:"Font Awesome' in body
            or "text-rendering:auto" in body
            or re.fullmatch(r"font-weight:\d+", body.strip()))

keep_machinery_rules = [r for r in machinery if keep_machinery(r)]

# ---------- 4. icon rules + per-family codepoints ----------
def last_class(sel):
    m = re.findall(r"\.([A-Za-z0-9_-]+)", sel)
    return m[-1] if m else None

keep_icons, cp_by_family = [], {f: set() for f in used_families}
for r in icon_rules:
    sels = [s.strip() for s in r[:r.index("{")].split(",")]
    matched = [last_class(s) for s in sels if last_class(s) in used]
    if not matched:
        continue
    keep_icons.append(r)
    cps = {int(m.group(1), 16) for m in re.finditer(r'content:"\\([0-9a-fA-F]+)"', r)}
    for g in matched:
        for fam in used[g]:
            cp_by_family[fam] |= cps

# ---------- 5. write the CSS ----------
header = (f"/* Font Awesome 6.5.1 — SUBSET of the vendored, byte-identical upstream file.\n"
          f"   Kept: {len(keep_faces)} @font-face, {len(keep_machinery_rules)} machinery and "
          f"{len(keep_icons)} icon rules — the {len(used)} icons this site uses ({elements} <i> elements)\n"
          f"   out of {len(icon_rules)} icon rules / {len(faces)} faces. Regenerate with\n"
          f"   tools/build-fontawesome-subset.py after adding icons, then re-run the pixel gate. */")
subset_css = "\n".join([header] + keep_machinery_rules + keep_faces + keep_icons) + "\n"
os.makedirs(FA + "subset", exist_ok=True)
open(FA + "subset/fa-subset.css", "w", encoding="utf-8").write(subset_css)

# ---------- 6. subset the fonts (outlines untouched) ----------
print(f"CSS: {len(css)} → {len(subset_css)} bytes ({round(100 - 100*len(subset_css)/len(css))}% μείωση)")
print(f"faces: {len(faces)} → {len(keep_faces)} | icon rules: {len(icon_rules)} → {len(keep_icons)} | machinery: {len(machinery)} → {len(keep_machinery_rules)}")
for fam in sorted(used_families):
    src = FA + "webfonts/" + FACE_FOR[fam]
    dst = FA + "subset/" + FACE_FOR[fam]
    cps = sorted(cp_by_family[fam])
    cmd = [PYFT, src, f"--output-file={dst}", "--flavor=woff2",
           "--unicodes=" + ",".join(f"U+{c:04X}" for c in cps)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode:
        print(f"  ✗ {fam}: {res.stderr[-300:]}"); sys.exit(1)
    # Restore head.flags from upstream. fontTools' woff2 encoder sets the
    # informational "lossless" bit (0x0800), and the pixel gate showed a residual
    # ~374/9.7M-pixel antialiasing difference on the 14px star glyphs with it set.
    # Everything else (outlines, hmtx, hhea/OS-2 metrics) is already identical.
    from fontTools.ttLib import TTFont
    orig, sub = TTFont(src), TTFont(dst)
    if orig["head"].flags != sub["head"].flags:
        sub["head"].flags = orig["head"].flags
        sub.save(dst)
    a, b = os.path.getsize(src), os.path.getsize(dst)
    print(f"  {fam:8} {len(cps):2} glyphs  {a:,} → {b:,} B  ({round(100-100*b/a)}% μείωση)  {os.path.basename(dst)}")
json.dump({"elements": elements, "icons": sorted(used), "codepoints": {f: sorted(hex(c) for c in v) for f, v in cp_by_family.items()}},
          open(SITE + "tools/fontawesome-subset.json", "w"), indent=1)
print("\nγράφτηκε tools/fontawesome-subset.json (inventory για μελλοντικό audit)")
