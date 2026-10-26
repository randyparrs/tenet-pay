"""Simulated Bradbury and Lacre for the rehearsal of the gateway Worker (worker/test/rehearsal.mjs): the two
gateway judge contracts exactly as built (contracts/), owned by the gateway key, in Lacre's simulated SDK; a
KeyCache with the 24-hour quarantine (register_key, confirm_key, key_status); a Lacre Verifier that records emails
signed with the rehearsal's throwaway DKIM key for the example store; and a committee that answers by the text it
is shown (a fixed answer per kind of email or store answer, five equal). Local HTTP on 127.0.0.1 only.

A transaction reads ACCEPTED on its first status read and FINALIZED from the second; its effects on the KeyCache and
on Lacre's records apply when it is FINALIZED. Like Bradbury, a read in final state answers with the accepted state:
each read that comes before its transaction is FINALIZED is counted (early_final_reads); the Worker must never need
one.

    python tools/lacre_boot.py tests/gw_gl_stub.py <port> <owner address> <domain> <selector> <dkim n hex> <e>
"""
import datetime
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import judge_gw_regression as reg  # noqa: E402

reg.setup()
H = reg.base
sys.path.insert(0, str(Path(__import__("os").environ["LACRE_DIR"]) / "tools"))
import headers_blob  # noqa: E402  (Lacre)


def when_iso(t):
    return datetime.datetime.fromtimestamp(int(t), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


UNKNOWN = []


def lookup(prompt):
    """The committee: one answer per kind of text, five equal."""
    r = _lookup(prompt)
    if r is None:
        i = prompt.find(chr(10) + "BEGIN-")
        UNKNOWN.append(("date" if "may give a delivery date" in prompt else "?") + " | " + prompt[i:i + 160])
    return r


def email_of(prompt):
    """The email block of a prompt (the rules around it never count as the email's text)."""
    nl = chr(10)
    i = prompt.find(nl + "BEGIN-")
    j = prompt.find(nl + "END-", i + 1)
    return prompt[i:j] if i >= 0 and j > i else ""


def _lookup(prompt):
    if "Question: what event of the order" in prompt:
        mail = email_of(prompt)
        for snippet, v in (("Refund issued", "refund_issued"), ("was delivered on", "delivered"), ("has shipped", "shipped"),
                           ("Thanks for your order", "order_confirmed")):
            if snippet in mail:
                return "type", [H.verdict_raw(v)] * 5
        return "type", [H.verdict_raw("other")] * 5
    if "Question: the email may give a delivery date" in prompt:
        return "date", [{"month": None, "day": None, "year": None}] * 5  # the rehearsal's emails carry labeled dates
    if "Question: does what the buyer's account" in prompt:
        return "q1", [H.verdict_raw("differs")] * 5
    if "Question: what kind of answer is the RESPONSE" in prompt or "the buyer says the order never arrived" in prompt:
        for snippet, v in (("we sent the wrong charger", "admits"), ("serial", "disputes_with_fact"), ("test report", "disputes_with_fact")):
            if snippet in prompt:
                return "q2", [H.verdict_raw(v)] * 5
        return "q2", [H.verdict_raw("general_denial")] * 5
    return None


class Chain:
    def __init__(self, owner, domain, selector, n, e):
        H.OWNER = owner
        H.DOMAIN, H.SELECTOR = domain, selector
        self.key = {"n": n, "e": e, "key_bits": n.bit_length(), "sha256": hashlib.sha256(b"%x" % n).hexdigest()}
        H.SHOP_KEY = self.key
        self.w = {k: H.World(k) for k in ("mail", "subjective")}
        self.node = self.w["mail"].node
        self.node.keycache.records.clear()
        self.dns = {(domain, selector): self.key}
        self.tx, self.records, self.rec_tx, self.early = {}, {}, {}, 0
        self.unknown = UNKNOWN
        self.sends = {"judge": 0, "attest": 0, "set_merchant": 0, "register_key": 0, "confirm_key": 0}

    def new_tx(self, item):
        t = "0x%064x" % (len(self.tx) + 1)
        self.tx[t] = dict(item, reads=0)
        return t

    def status(self, t):
        x = self.tx[t]
        x["reads"] += 1
        final = x["reads"] >= 2
        if final and x.get("last") != "FINALIZED" and "apply" in x:
            x["apply"]()
        x["last"] = "FINALIZED" if final else "ACCEPTED"
        result = "NO_MAJORITY" if x.get("result") == "split" else "AGREE"
        return {"status": x["last"], "result": result, "done": final}

    def final_of(self, kind):
        return any(x["kind"] == kind and x.get("last") == "FINALIZED" for x in self.tx.values())

    # judges
    def judge(self, kind, claim, step, when, sender):
        w = self.w[kind]
        w.committee.lookup = lookup
        r = w.write(sender, when_iso(when), "judge", claim, step)
        self.sends["judge"] += 1
        st = json.loads(step)
        to = st["chain"]
        for raw in st["submissions"]:
            to = H.fold(to, raw)
        return self.new_tx({"kind": "judge", "result": r[0], "error": r[1] if r[0] == "error" else None, "to": to})

    def verdict(self, kind, chain, final):
        raw = self.w[kind].c.get_verdict(chain)
        if not raw:
            return None
        if final and not any(x["kind"] == "judge" and x["to"] == chain and x["result"] == "ok" and x.get("last") == "FINALIZED"
                             for x in self.tx.values()):
            self.early += 1
        return json.loads(raw)

    def set_merchant(self, kind, merchant, terms, when, sender):
        self.sends["set_merchant"] += 1
        w = self.w[kind]
        holder = {}
        t = self.new_tx({"kind": "set_merchant:" + kind, "result": "pending"})

        def apply():
            holder["r"] = w.write(sender, when_iso(when), "set_merchant", merchant, terms)
            self.tx[t]["result"] = holder["r"][0]
        self.tx[t]["apply"] = apply
        return t

    def get_merchant(self, kind, merchant, terms_hash, final):
        return self.w[kind].c.get_merchant(merchant, terms_hash)

    # KeyCache
    def register_key(self, domain, selector, when):
        self.sends["register_key"] += 1
        t = self.new_tx({"kind": "register_key"})

        def apply():
            key = self.dns.get((domain, selector))
            if key and (domain, selector) not in self.node.keycache.records:
                self.node.keycache.add(domain, selector, key, state="pending")
                self.node.keycache.records[(domain, selector)]["first_seen"] = when_iso(when)
                self.node.keycache.records[(domain, selector)]["activated_at"] = ""
        self.tx[t]["apply"] = apply
        return t

    def confirm_key(self, domain, selector, when):
        self.sends["confirm_key"] += 1
        t = self.new_tx({"kind": "confirm_key"})

        def apply():
            rec = self.node.keycache.records.get((domain, selector))
            if not rec or rec["state"] != "pending":
                return
            first = datetime.datetime.fromisoformat(rec["first_seen"].replace("Z", "+00:00")).timestamp()
            if int(when) >= first + 86400:  # Lacre's QUARANTINE: 24 hours
                rec["state"], rec["activated_at"] = "active", when_iso(when)
        self.tx[t]["apply"] = apply
        return t

    def key_status(self, domain, selector):
        return dict(self.node.keycache.records.get((domain, selector), {}))

    # Lacre Verifier
    def attest(self, blob, domain, selector, raw, requester):
        raw_b = raw.encode("latin-1")
        if blob != headers_blob.build(raw_b, domain, selector):
            raise ValueError("the blob is not the one Lacre's headers_blob cuts")
        ks = self.node.keycache.records.get((domain, selector))
        if not ks or ks["state"] != "active":
            raise ValueError("key not active")
        rec = H.record_for(raw_b, requester=requester)
        if not (rec["valid"] and rec["aligned"]):
            raise ValueError("signature not valid or not aligned")
        rid = str(300 + len(self.records))
        self.records[rid] = rec
        self.sends["attest"] += 1
        t = self.new_tx({"kind": "attest"})
        self.tx[t]["apply"] = lambda: self.node.verifier.final.update({rid: rec})
        self.rec_tx[rid] = t
        return t

    def find(self, bh, final):
        for rid, rec in self.records.items():
            if rec["bh"] == bh:
                if final and self.tx[self.rec_tx[rid]].get("last") != "FINALIZED":
                    self.early += 1
                return rid
        return None

    def foreign(self, claim, step, when):
        """CM11: an email of another store (a Lacre record of shop.rpmdev.app) as evidence on the gateway judge."""
        w = self.w["mail"]
        w.committee.lookup = lookup
        r = w.write(H.RELAYER, when_iso(when), "judge", claim, step)
        st = json.loads(step)
        to = st["chain"]
        for raw in st["submissions"]:
            to = H.fold(to, raw)
        v = w.c.get_verdict(to)
        return {"write": r[0], "verdict": json.loads(v) if v else None}


def serve(port, chain):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
            try:
                out, code = route(self.path, body), 200
            except Exception as error:
                out, code = {"error": "%s: %s" % (type(error).__name__, error)}, 500
            data = json.dumps(out).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def route(path, b):
        if path == "/judge":
            return {"tx": chain.judge(b["kind"], b["claim"], b["step"], b["when"], b["sender"])}
        if path == "/status":
            return chain.status(b["tx"])
        if path == "/verdict":
            return {"verdict": chain.verdict(b["kind"], b["chain"], b["final"])}
        if path == "/set_merchant":
            return {"tx": chain.set_merchant(b["kind"], b["merchant"], b["terms"], b["when"], b["sender"])}
        if path == "/get_merchant":
            return {"terms": chain.get_merchant(b["kind"], b["merchant"], b["terms_hash"], b["final"])}
        if path == "/register_key":
            return {"tx": chain.register_key(b["domain"], b["selector"], b["when"])}
        if path == "/confirm_key":
            return {"tx": chain.confirm_key(b["domain"], b["selector"], b["when"])}
        if path == "/key_status":
            return {"status": chain.key_status(b["domain"], b["selector"])}
        if path == "/attest":
            return {"tx": chain.attest(b["blob"], b["domain"], b["selector"], b["raw"], b["requester"])}
        if path == "/record":
            return {"record": chain.find(b["bh"], b["final"])}
        if path == "/count":
            return {"sends": chain.sends, "early_final_reads": chain.early, "tx_errors": [x.get("error") for x in chain.tx.values() if x.get("error")],
                    "unknown_prompts": chain.unknown[:6]}
        if path == "/foreign":
            return chain.foreign(b["claim"], b["step"], b["when"])
        raise ValueError("no route " + path)

    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    port, owner, domain, selector, n_hex, e = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    chain = Chain(owner, domain, selector, int(n_hex, 16), int(e))
    print("READY", flush=True)
    serve(int(port), chain)


if __name__ == "__main__":
    main()
