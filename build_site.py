"""Builds the files of the gateway pages that come from elsewhere, so they cannot drift from their origin by hand:
- site/circle.js       Tenet's site/circle.js (the tenet submodule) reading the gateway Worker's address (meta
                       tenet-gateway-api), back to the page's own route; the pages that use it are in folders (pay/,
                       orders/), so Google sends the buyer back to the page they left and the SDK loads from beside
                       this script
- site/circle-sdk.js   Tenet's site/circle-sdk.js as it is (Circle's Web SDK, Apache-2.0; see NOTICE.md)
- site/terms.js        worker/src/terms.js (the checkout renders and hashes the terms with it)
- merchants-site/      (merchants.paytenet.site, its own Pages project): tenet.js and terms.js byte for byte the same files as
                       site/ (one origin each: site/tenet.js and worker/src/terms.js), and the favicon
- site/index.html      the home page's three numbers, from Tenet's site data (tenet/site/data/tenet.json): verdicts as
                       expected in the Bradbury run, correct decisions of the committee in run C3, live orders settled
Usage: py -3.12 build_site.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TENET_SITE, SITE, MER = ROOT / "tenet" / "site", ROOT / "site", ROOT / "merchants-site"


def read(p):
    return p.read_text(encoding="utf-8")


circle = read(TENET_SITE / "circle.js")
for old, new in (('meta[name="tenet-demo-api"]', 'meta[name="tenet-gateway-api"]'), ("route: location.hash || '#demo-shop'", "route: location.hash || '#/'"),
                 ("redirectUri: location.origin,", "redirectUri: location.origin + location.pathname,"),
                 ("/* Sign in with Google: the page leaves for Google and comes back to this site's root */",
                  "/* Sign in with Google: the page leaves for Google and comes back to this same page */"),
                 ("s.src = 'circle-sdk.js' + (version ? '?v=' + version : '');",
                  "s.src = new URL('circle-sdk.js', me || location.href).href + (version ? '?v=' + version : '');")):
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

# The home page's numbers come from the same data as tenet.rpmdev.app, at the pinned Tenet commit.
data = json.loads(read(TENET_SITE / "data" / "tenet.json"))
cases = data["bradbury_run"]["cases"]
c3 = re.fullmatch(r"(\d+) / (\d+)", next(r for r in data["measurements"]["runs"] if r["id"] == "C3")["results"]["correct decision"])
metrics = {"verdicts-expected": sum(1 for c in cases if c["passed"] is True), "verdicts-total": len(cases),
           "committee-correct": int(c3[1]), "committee-total": int(c3[2]),
           "orders-settled": sum(1 for c in data["live_cases"] if c["status"] == "settled")}
home = read(SITE / "index.html")
for field, value in metrics.items():
    home, n = re.subn(r'(<span data-field="' + field + r'">)[^<]*(</span>)', r"\g<1>" + str(value) + r"\g<2>", home)
    assert n == 1, field
(SITE / "index.html").write_text(home, encoding="utf-8", newline="\n")
print("site/index.html", metrics)
