"""Vectors for worker/test/terms.test.mjs: arbiter/terms.render on every structure the project has (the
21 expected structures of F1, the live test and Demo Shop terms) and variations of each (business days, every
precondition, exclusion and seller type, waits, deadlines, grace), with three hold periods and both window
texts. The JS copy has to give the same SHA-256 on all of them.
Usage: py -3.12 worker/test/make_terms_vectors.py
"""
import copy
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tenet" / "arbiter"))
import terms  # noqa: E402

structs = [p["expected"] for p in json.load(open(ROOT / "cases" / "f1-policies.json", encoding="utf-8"))["policies"]]
structs.append(json.load(open(ROOT / "tenet" / "cases" / "br-cases.json", encoding="utf-8"))["structure"])
structs.append(json.load(open(ROOT / "tenet" / "worker" / "src" / "demo-data.json", encoding="utf-8"))["terms"]["structure"])
variants = []
for s in structs:
    variants.append(s)
    if not s.get("clear"):
        continue
    v = copy.deepcopy(s)
    v.update(day_type="business", preconditions=["contact_seller", "seller_attempt_resolution"], seller_wait_hours=48,
             seller_types="third_party", excluded_payments=["cash", "qr", "off_platform"], category_exclusions=True,
             excluded_causes=["customs", "weather", "buyer_absent", "buyer_address", "force_majeure"])
    for r in v["rules"]:
        r.update(wait_days=1, wait_from="promised", deadline_days=0, late_grace_days=1)
    variants.append(v)
    v = copy.deepcopy(s)
    v.update(preconditions=["contact_seller"], seller_wait_hours=0, seller_types="first_party", excluded_payments=["cash"],
             excluded_causes=["weather"])
    variants.append(v)
out = []
for s in variants:
    for hold in (30, 7, 180):
        for w in (None, {"response": "5 minutes", "proof": "5 minutes"}):
            text = terms.render(s, hold, w)
            out.append({"structure": s, "hold": hold, "windows": w, "sha256": "0x" + hashlib.sha256(text.encode()).hexdigest()})
json.dump(out, open(Path(__file__).with_name("terms-vectors.json"), "w", encoding="utf-8"), indent=0)
print(len(variants), "structures,", len(out), "vectors")
