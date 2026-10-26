"""Builds the files of the gateway pages that come from elsewhere, so they cannot drift from their origin by hand:
- site/circle.js       Tenet's site/circle.js (the tenet submodule) reading the gateway Worker's address (meta
                       tenet-gateway-api), back to the page's own route
- site/circle-sdk.js   Tenet's site/circle-sdk.js as it is (Circle's Web SDK, Apache-2.0; see NOTICE.md)
- site/terms.js        worker/src/terms.js (the checkout renders and hashes the terms with it)
- merchants-site/      (merchants.paytenet.site, its own Pages project): tenet.js and terms.js byte for byte the same files as
                       site/ (one origin each: site/tenet.js and worker/src/terms.js), and the favicon
Usage: py -3.12 build_site.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TENET_SITE, SITE, MER = ROOT / "tenet" / "site", ROOT / "site", ROOT / "merchants-site"


def read(p):
    return p.read_text(encoding="utf-8")


circle = read(TENET_SITE / "circle.js")
for old, new in (('meta[name="tenet-demo-api"]', 'meta[name="tenet-gateway-api"]'), ("route: location.hash || '#demo-shop'", "route: location.hash || '#/'")):
    assert circle.count(old) == 1, old
    circle = circle.replace(old, new)
(SITE / "circle.js").write_text("/* Copied from site/circle.js by build_site.py for the new paytenet pages; do not edit here. */\n" + circle, encoding="utf-8", newline="\n")
(SITE / "circle-sdk.js").write_text(read(TENET_SITE / "circle-sdk.js"), encoding="utf-8", newline="\n")
terms = "// Copied from worker/src/terms.js by build_site.py; do not edit here.\n" + read(ROOT / "worker" / "src" / "terms.js")
(SITE / "terms.js").write_text(terms, encoding="utf-8", newline="\n")
print("site/circle.js, site/circle-sdk.js, site/terms.js")
# The store panel is another Pages project, so it carries its own copies; the rehearsal checks they are the same bytes.
for name, data in (("tenet.js", (SITE / "tenet.js").read_bytes()), ("terms.js", terms.encode()), ("favicon.svg", (SITE / "favicon.svg").read_bytes())):
    (MER / name).write_bytes(data)
    print("merchants-site/" + name, len(data), "bytes")
