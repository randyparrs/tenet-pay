"""Builds the two judge contracts of the stores gateway from Tenet's judge templates (the tenet submodule), separate
from Tenet's live test and Demo Shop judges, which are not touched: contracts/judge_mail_gw.py and
contracts/judge_subjective_gw.py.

They are the live templates (contracts/judge_mail_template.py, judge_subjective_template.py) and common part
(contracts/judge_common.py) with the exact changes listed below and nothing else (CM0): each change names the
text it replaces, which has to appear exactly once. Then the same steps as contracts/build_judge_v2.py
(constants from the measured modules, docstrings out, short local names, one space per level), and the
spaces between tokens dropped (minify, checked to give the same AST), to stay under the deploy gas cap.

Changes:
- CM-D10, terms by version: each version of a store's terms is kept under merchant|terms_hash and never
  replaced (M6 when the same hash comes with another text); the judge applies the version whose hash the
  claim carries; versions(merchant) lists them.
- CM-D14: the minimum DKIM key size comes from the store's terms (profile.min_key_bits, at least 1024).
- CM-D6, labeled dates: the store declares the patterns of the promised date and, optionally, of the
  delivery date (profile.promised_pattern, profile.delivery_pattern); a labeled date counts whatever type
  the committee gives the email; without a label, the committee date as in the live judge.
- CM-D6, body cap: bodies over 12 288 bytes are ignored with I10.
- CM-D12: the text comes from the structure of the signed body (multipart with its closing delimiter:
  text/plain, else the HTML without hidden parts; quoted-printable and base64 per part); a single part
  with HTML tags is ignored with I11; anything else ambiguous is read whole as text.
- I11 never harms the buyer: an I11 email counts against the store only if this order's number is in its
  raw body and it was signed after the payment (else I8 or I9, as today). With one, a late claim without
  the dates waits for the store's response window (NOT_YET, "store email unreadable"); once the window is
  closed (the store's response, which the judge reads only as that, or the escrow's no_response) and the
  dates are still missing, the late rule's refund is paid.

Bradbury Phase 2 (Consensus v0.6): contracts/judge_subjective_gw_p2.py is judge_subjective_gw.py with the header and
the std lib names of Tenet's build_p2 (build_judge_v2.P2_HEAD, P2_SWAPS), and nothing else. The email judge waits
for Lacre on Phase 2.

Usage: py -3.12 contracts/build_judge_gw.py           writes both judges and judge_build_gw.json
       py -3.12 contracts/build_judge_gw.py --check   builds them in memory and compares them with the files
"""
import ast
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TENET = ROOT / "tenet"
sys.path.insert(0, str(TENET / "contracts"))
import build_judge_v2 as B  # noqa: E402

MAX_BODY = 12288

COMMON = [
    ("""    m = json.loads(ct.mer.get(c["merchant"], "") or "null")
    if not m:
        _f("M4")
    if c["terms_hash"] != m["terms_hash"]:
        _f("M5")
""", """    # CM-D10: the version of the terms the buyer accepted at payment, the one whose hash the claim carries.
    m = json.loads(ct.mer.get(c["merchant"] + "|" + c["terms_hash"].lower(), "") or "null")
    if not m:
        _f("M4")
"""),
    ("""              and all(isinstance(p[k], str) for k in ("order_pattern", "date_pattern")))
""", """              and all(isinstance(p[k], str) for k in ("order_pattern", "promised_pattern", "delivery_pattern"))
              and p["promised_pattern"] != "" and re.compile(p["promised_pattern"]).groups == 1
              and (p["delivery_pattern"] == "" or re.compile(p["delivery_pattern"]).groups == 1)
              and _pos(p["min_key_bits"]) and p["min_key_bits"] >= 1024
              and re.fullmatch("0x[0-9a-f]{64}", t["terms_hash"]) is not None)
"""),
    ("""def _k(x):
""", """def _setm(ct, merchant, terms):
    \"\"\"CM-D10: versions are only added, each under its hash; a registered version never changes.\"\"\"
    if gl.message.sender_address != ct.own:
        _f("M1")
    k = _addr(merchant)
    t = _terms(terms)
    h = json.loads(t)["terms_hash"]
    o = ct.mer.get(k + "|" + h, "")
    if o and o != t:
        _f("M6")
    if not o:
        ct.mer[k + "|" + h] = t
        ct.vs[k] = (ct.vs.get(k, "") + "," + h).strip(",")
    return k + "|" + h


def _k(x):
"""),
]

CLASS = [
    ("""    mer: TreeMap[str, str]
""", """    mer: TreeMap[str, str]
    # merchant -> hashes of its terms versions, in the order they were added
    vs: TreeMap[str, str]
"""),
    ("""    def set_merchant(self, merchant: str, terms: str) -> str:
        if gl.message.sender_address != self.own:
            _f("M1")
        k = _addr(merchant)
        self.mer[k] = _terms(terms)
        return k
""", """    def set_merchant(self, merchant: str, terms: str) -> str:
        return _setm(self, merchant, terms)
"""),
    ("""    def get_merchant(self, merchant: str) -> str:
        return self.mer.get(_k(merchant), "")
""", """    def get_merchant(self, merchant: str, terms_hash: str) -> str:
        return self.mer.get(_k(merchant) + "|" + _k(terms_hash), "")

    @gl.public.view
    def versions(self, merchant: str) -> str:
        return self.vs.get(_k(merchant), "")
"""),
]

MAIL = CLASS + [
    ("""            # and the verdict lists it with the code of why (contracts/ERRORS.md, I1 to I9).
""", """            # and the verdict lists it with the code of why (contracts/ERRORS.md and gateway/ERRORS-gw.md).
"""),
    ("""WSP = re.compile(rb"[ \\t]+")
""", """WSP = re.compile(rb"[ \\t]+")
MAXB = %d
# CM-D12: the text of a store email from the structure of its signed body (the record keeps no headers).
TAG = re.compile(r"(?i)<(?:!doctype|!--|html|head|body|div|span|table|tr|td|p|br|a|img|style|script|font|center|b|i|u|strong|em|h[1-6])[\\s>/]")
HID = re.compile(r\"\"\"<(\\w+)\\b[^>]*\\bstyle\\s*=\\s*["'][^"']*(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden)[^"']*["'][^>]*>.*?</\\1\\s*>\"\"\", re.I | re.S)
BLK = re.compile(r"</?(?:p|div|tr|table|h[1-6]|li|ul|ol|br|hr|td|th)\\b[^>]*>", re.I)
ENT = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\\xa0"}


def _en(m):
    x = m.group(1)
    if x[0] == "#":
        try:
            return chr(int(x[2:], 16) if x[1] in "xX" else int(x[1:]))
        except Exception:
            return m.group(0)
    return ENT.get(x, m.group(0))


def _html(t):
    # tests/b4_text.html_text: no comments, head, style, script or hidden elements; one line per block.
    t = re.sub(r"<!--.*?-->", " ", t, flags=re.S)
    t = re.sub(r"<(head|style|script)\\b.*?</\\1\\s*>", " ", t, flags=re.I | re.S)
    p = None
    while p != t:
        p, t = t, HID.sub(" ", t)
    t = re.sub(r"<[^>]+>", " ", BLK.sub("\\n", t))
    t = re.sub(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});", _en, t)
    return "\\n".join(x for x in (re.sub(r"[ \\t\\xa0]+", " ", y).strip() for y in t.splitlines()) if x)


def _qp(b):
    b = re.sub(rb"[ \\t\\r]+(?=\\n)", b"", b)
    b = re.sub(rb"=\\n", b"", b)
    return re.sub(rb"=([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), b)


def _parts(s):
    # Multipart: the first delimiter line (a preamble may come before) and the closing one are required.
    m = re.search(r"(?m)^--([^\\r\\n]{1,70}?)[ \\t]*\\r?$", s)
    if not m:
        return None
    d = "--" + m.group(1)
    j = s.find("\\r\\n" + d + "--", m.start())
    if j < 0:
        return None
    out = []
    for ch in s[m.start() + len(d):j].split("\\r\\n" + d):
        n = ch.find("\\r\\n")
        if n < 0 or ch[:n].strip():
            return None
        ch = ch[n + 2:]
        h, _, body = ("", "", ch[2:]) if ch.startswith("\\r\\n") else ch.partition("\\r\\n\\r\\n")
        h = re.sub(r"\\r\\n[ \\t]+", " ", h).lower()
        ty = re.search(r"(?m)^content-type:[ \\t]*([a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+)", h)
        te = re.search(r"(?m)^content-transfer-encoding:[ \\t]*([a-z0-9-]+)", h)
        raw = body.encode("latin-1")
        te = te.group(1) if te else "7bit"
        if te == "quoted-printable":
            raw = _qp(raw)
        elif te == "base64":
            try:
                raw = base64.b64decode(re.sub(rb"\\s", b"", raw))
            except Exception:
                return None
        out.append((ty.group(1) if ty else "text/plain", raw.decode("utf-8", "replace")))
    return out


def _tx(b):
    \"\"\"The text the committee reads, or None (I11) for a single part with HTML tags.\"\"\"
    ps = _parts(b.decode("latin-1")) or []
    for want in ("text/plain", "text/html"):
        for ty, t in ps:
            if ty == want:
                return t.replace("\\r\\n", "\\n").strip() if want == "text/plain" else _html(t)
    t = b.decode("utf-8", "replace")
    return None if TAG.search(t) else t.replace("\\r\\n", "\\n").strip()
""" % MAX_BODY),
    ("""            ok = bool(rec) and _fin(ver).check_for(rid, m["domain"], 1024, str(rec.get("requester", ""))) is True
""", """            ok = bool(rec) and _fin(ver).check_for(rid, m["domain"], int(m["profile"]["min_key_bits"]),
                                                   str(rec.get("requester", ""))) is True
"""),
    ("""        try:
            b = base64.b64decode(str(e["body_b64"]), validate=True)
            ok = len(b) <= 32768 and _bh(b, rec.get("body_canon", "")) == rec.get("bh")
        except Exception:
            ok = False
        if not ok:
            return "I7"
        text = b.decode("utf-8", "replace")
""", """        try:
            b = base64.b64decode(str(e["body_b64"]), validate=True)
        except Exception:
            return "I7"
        if len(b) > MAXB:
            return "I10"
        try:
            ok = _bh(b, rec.get("body_canon", "")) == rec.get("bh")
        except Exception:
            ok = False
        if not ok:
            return "I7"
        text = _tx(b)
        if text is None:
            # CM-D12: counts against the store only if it names this order and was signed after the payment.
            if c["order_number"].encode() not in b:
                return "I8"
            if _d(int(rec["signed_at"])) < _d(c["paid_at"]):
                return "I9"
            return "I11"
"""),
    ("""        fixed = re.findall(p["date_pattern"], text)
        r = {"key": key, "record": ver.as_hex.lower() + "/" + rid, "signed_at": int(rec["signed_at"]),
             "type": _ask(_pm("type", text), _ct), "date": ""}
        if r["type"] in DATE_TYPES and not fixed:
            r["date"] = _ask(_pm("date", text), lambda raw: (lambda q: None if q is None else _rd(q, text, paid))(_cd(raw)))
        elif fixed:
            r["date"] = fixed[0]
        return r
""", """        # CM-D6: a labeled date counts whatever type the committee gives the email.
        P = re.findall(p["promised_pattern"], text)
        D = re.findall(p["delivery_pattern"], text) if p["delivery_pattern"] else []
        r = {"key": key, "record": ver.as_hex.lower() + "/" + rid, "signed_at": int(rec["signed_at"]),
             "type": _ask(_pm("type", text), _ct), "pr": P[0] if P else "", "dl": D[0] if D else ""}
        if r["type"] in DATE_TYPES and not (P or D):
            d = _ask(_pm("date", text), lambda raw: (lambda q: None if q is None else _rd(q, text, paid))(_cd(raw)))
            if r["type"] == "shipped":
                r["pr"] = d
            elif r["type"] == "delivered":
                r["dl"] = d
        return r
"""),
    ("""    pr = next((e["date"] for e in es if e["type"] in ("order_confirmed", "shipped") and e["date"]), "")
    dl = next((e["date"] for e in es if e["type"] == "delivered" and e["date"]), "")
    if not (pr and dl):
        return "wait", "NOT_YET", 0, "signed emails required"
""", """    pr = next((e["pr"] for e in es if e["pr"]), "")
    dl = next((e["dl"] for e in es if e["dl"]), "")
    if not (pr and dl):
        # I11 never harms the buyer: the store has its response window to send a readable email; once the
        # window is closed (its response or the escrow's no_response) without the dates, the late rule pays.
        if not st["u"]:
            return "wait", "NOT_YET", 0, "signed emails required"
        if not st["nr"]:
            return "wait", "NOT_YET", 0, "store email unreadable"
        r = next((x for x in pol["rules"] if x["event"] == "late"), None)
        if not (pol.get("clear") and r):
            return "decide", "NO_DECISION" if not pol.get("clear") else "DENY", 0, "per policy"
        return "decide", "REFUND", c["amount_cents"] * r["refund_percent"] // 100, "store email unreadable"
"""),
    ("""def _apm(ct, st, c, m, k, v):
    r = ct._mail(v, c, m, [e["key"] for e in st["emails"]])
    if isinstance(r, str):
        return r
""", """def _apm(ct, st, c, m, k, v):
    if k != "evidence":
        # the store's response or the escrow's no_response: the store's window is closed
        st["nr"] = 1
        return
    r = ct._mail(v, c, m, [e["key"] for e in st["emails"]])
    if isinstance(r, str):
        if r == "I11":
            st["u"] = 1
        return r
"""),
    ("""{"emails": []}, {("buyer", "evidence")}, _apm,""",
     """{"emails": [], "u": 0, "nr": 0},
                    {("buyer", "evidence"), ("merchant", "response"), ("escrow", "no_response")}, _apm,"""),
]

SUBJECTIVE = CLASS + [
    ("""import json
""", """import json
import re
"""),
]

TARGETS = {"judge_mail_gw": (TENET / "contracts" / "judge_mail_template.py", B.mail_consts, MAIL),
           "judge_subjective_gw": (TENET / "contracts" / "judge_subjective_template.py", B.subjective_consts, SUBJECTIVE)}


def minify(body):
    """Drops the spaces ast.unparse puts between tokens ("a = b" -> "a=b"), keeping one only where two
    names, numbers or strings would touch. Same program: checked by comparing the AST before and after."""
    import io
    import tokenize
    lines = body.split("\n")
    out = {}
    word = (tokenize.NAME, tokenize.NUMBER, tokenize.STRING)
    prev = None
    for tok in tokenize.generate_tokens(io.StringIO(body).readline):
        if tok.type in (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER,
                        tokenize.COMMENT):
            prev = None
            continue
        row = tok.start[0]
        assert tok.end[0] == row, "a token over several lines"
        if row not in out:
            out[row] = lines[row - 1][:len(lines[row - 1]) - len(lines[row - 1].lstrip(" "))]
            prev = None
        if prev is not None and prev.type in word and tok.type in word:
            out[row] += " "
        out[row] += tok.string
        prev = tok
    small = "\n".join(out.get(i + 1, lines[i]) for i in range(len(lines)))
    assert ast.dump(ast.parse(small)) == ast.dump(ast.parse(body)), "minify changed the program"
    return small


def build_p2(built):
    """The built subjective judge with Tenet's Phase 2 header and names (minify took the space out of the import)."""
    first, rest = built.split("\n", 1)
    assert first.startswith('# { "Depends":')
    text = B.P2_HEAD + "\n" + rest
    for old, new in B.P2_SWAPS:
        old = old.replace(" import *", " import*")
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    assert "message_raw" not in text and "gl.Contract)" not in text
    compile(text, "judge_subjective_gw_p2", "exec")
    text.encode("ascii")
    return HERE / "judge_subjective_gw_p2.py", text


def patch(text, changes, where):
    for old, new in changes:
        n = text.count(old)
        assert n == 1, "%s: the text to replace appears %d times: %r" % (where, n, old[:80])
        text = text.replace(old, new)
    return text


def build(name):
    template_path, consts, changes = TARGETS[name]
    values, sources = consts()
    template = patch(template_path.read_text(encoding="ascii"), changes, template_path.name)
    common = patch(B.COMMON.read_text(encoding="ascii"), COMMON, "judge_common.py")
    a, b = template.index("# <<EACH-BEGIN>>\n"), template.index("# <<EACH-END>>\n")
    each = template[a + len("# <<EACH-BEGIN>>\n"):b]
    template = template[:a] + template[b + len("# <<EACH-END>>\n"):]
    marker = next(line for line in common.split("\n") if line.strip().startswith("# <<EACH>>"))
    common = common.replace(marker + "\n", each)
    const = "\n".join("%s = %s" % (k, v if isinstance(v, B.Expr) else repr(v)) for k, v in values.items())
    lines = template.replace("# <<CONST>>", const).replace("# <<COMMON>>", common).split("\n")
    head = 0
    while lines[head].startswith("#"):
        head += 1
    prov = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (template_path, B.COMMON, Path(__file__)) + sources}
    body = ast.unparse(B.short_locals(B.strip_docstrings(ast.parse("\n".join(lines[head:])))))
    body = minify(B.one_space(body.encode("ascii", "backslashreplace").decode()))
    assert lines[0].startswith('# { "Depends":') and lines[0].rstrip().endswith("}")
    built = lines[0] + "\n\n" + "\n".join(lines[1:head]) + "\n\n" + body + "\n"
    compile(built, name, "exec")
    built.encode("ascii")
    return HERE / (name + ".py"), built, prov


if __name__ == "__main__":
    if "--check" in sys.argv:
        # The deployed judges are these files byte for byte; a build from the pinned Tenet sources must give them again.
        bad = 0
        for target in TARGETS:
            path, text, _ = build(target)
            same = path.read_bytes() == text.encode("ascii")
            bad += not same
            print("same" if same else "DIFFERENT", path.relative_to(ROOT).as_posix(), hashlib.sha256(text.encode()).hexdigest())
            if target == "judge_subjective_gw":
                p2_path, p2_text = build_p2(text)
                same = p2_path.read_bytes() == p2_text.encode("ascii")
                bad += not same
                print("same" if same else "DIFFERENT", p2_path.relative_to(ROOT).as_posix(), hashlib.sha256(p2_text.encode()).hexdigest())
        sys.exit(1 if bad else 0)
    manifest = {}
    for target in TARGETS:
        path, text, prov = build(target)
        path.write_text(text, encoding="ascii", newline="\n")
        sha = hashlib.sha256(text.encode()).hexdigest()
        manifest[path.relative_to(ROOT).as_posix()] = {"bytes": len(text.encode()), "sha256": sha, "built_from": prov}
        print(path.relative_to(ROOT).as_posix(), len(text.encode()), "bytes, sha256", sha)
        if target != "judge_subjective_gw":
            continue  # the email judge (Router, gl.get_contract_at) waits for Lacre on Phase 2
        p2_path, p2_text = build_p2(text)
        p2_path.write_text(p2_text, encoding="ascii", newline="\n")
        p2_sha = hashlib.sha256(p2_text.encode()).hexdigest()
        manifest[p2_path.relative_to(ROOT).as_posix()] = {"bytes": len(p2_text.encode()), "sha256": p2_sha,
                                                          "built_from": {path.relative_to(ROOT).as_posix(): sha}}
        print(p2_path.relative_to(ROOT).as_posix(), len(p2_text.encode()), "bytes, sha256", p2_sha)
    (HERE / "judge_build_gw.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n",
                                              encoding="ascii", newline="\n")
