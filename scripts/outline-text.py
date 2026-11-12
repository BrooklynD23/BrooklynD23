"""Dev-only: outlines the header text from OFL fonts into scripts/text.json (path data), so the
Node generator needs no fonts. Needs fonttools + brotli. Re-run only if the name or tagline changes.
Usage: python scripts/outline-text.py FRAUNCES_600_WOFF2 GEIST_VAR_WOFF2"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.varLib import instancer

n = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")


def outline(f, text, size, x, y, track=0.0, kern=None):
    gs, cmap, s = f.getGlyphSet(), f.getBestCmap(), size / f["head"].unitsPerEm
    pen, bp, cx = SVGPathPen(gs, ntos=n), BoundsPen(gs), x
    for i, ch in enumerate(text):
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(pen, (s, 0, 0, -s, cx, y)))
        g.draw(TransformPen(bp, (s, 0, 0, -s, cx, y)))
        cx += g.width * s + track + (kern or {}).get(text[i:i + 2], 0) * size
    return {"d": pen.getCommands(), "box": [round(v, 1) for v in bp.bounds]}


fr = TTFont(sys.argv[1])
ge = instancer.instantiateVariableFont(TTFont(sys.argv[2]), {"wght": 600})
out = {
    "name": outline(fr, "Danny T.", 50, 40, 74),
    "role": outline(ge, "DEVELOPER  ·  PHOTOGRAPHER", 11.5, 42, 100, track=2.6),
}
json.dump(out, open(os.path.join(os.path.dirname(__file__), "text.json"), "w"))
print({k: v["box"] for k, v in out.items()}, {k: len(v["d"]) for k, v in out.items()})
