"""Writes data/bradbury-archive.jsonl: the record of the gateway's transactions on Bradbury (the judges and Lacre)
from before GenLayer reset it in October 2026. Bradbury's explorer no longer has them, so My orders and the stores'
panel link each one to this file, marked "archived" (site/tenet.js, glTx).

The rows come from the gateway Worker's public API: the orders of each registered store (GET /api/stores/<wallet>),
one row per transaction, at its last state, as the pages show it. Nothing else is read and nothing is sent.
Usage: py -3.12 archive_bradbury.py
"""
import datetime
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://tenet-gateway.randyparra.workers.dev"
STORES = {"techshopping.site": "0x7A090C3414e98fe722A819A1d29C93B04a52eD6c"}
ARCHIVED_BEFORE = int(datetime.datetime(2026, 10, 28, tzinfo=datetime.timezone.utc).timestamp())  # as in site/tenet.js
OUT = ROOT / "data" / "bradbury-archive.jsonl"


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "tenet-pay-archive/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    rows = []
    for domain, wallet in STORES.items():
        for o in get("/api/stores/" + wallet).get("orders", []):
            ev = [e for e in o.get("events", []) if e.get("tx") and e.get("net") in ("bradbury", "lacre")
                  and e["at"] < ARCHIVED_BEFORE]
            for i, e in enumerate(ev):
                if any(x["tx"].lower() == e["tx"].lower() for x in ev[i + 1:]):
                    continue  # logged again later: the row keeps its last state
                rows.append({"tx": e["tx"], "network": "bradbury-before-reset", "contract": "judge" if e["net"] == "bradbury" else "lacre",
                             "at": datetime.datetime.fromtimestamp(e["at"], datetime.timezone.utc).isoformat(),
                             "store": domain, "order": o["order"], "what": e["what"]})
    rows.sort(key=lambda r: (r["at"], r["order"], r["tx"]))
    OUT.write_text("".join(json.dumps(r, ensure_ascii=True) + "\n" for r in rows), encoding="ascii")
    print("%s: %d transactions, %d orders" % (OUT.relative_to(ROOT), len(rows), len({r["order"] for r in rows})))


if __name__ == "__main__":
    main()
