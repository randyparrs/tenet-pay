"""CM1, regression: the whole local run of the live judges (tests/judge_v2_stub_run.py,
Lacre's simulated SDK, recorded committee answers of C3, B3 and ND) against the two gateway judges
(contracts/). The live judges' files are not touched; the run points the harness at the gateway
contracts and registers the terms with the gateway profile (the B3 date_pattern split into the promised and
the delivery label, min_key_bits 1024).

Expected differences, by design, and how the run takes them:
- CM-D10: a claim with a terms hash that has no registered version gives M4 (in the live judges, M5); the
  gateway codes are in contracts/ERRORS-gw.md.
- CM-D12: the gateway judge reads the email text without the whitespace at its ends (as tests/b4_text.py,
  the text B4 measured), so the B3 prompts differ from the recorded ones only by the trailing line break: J2
  replays the B3 answers on that text. CM2 measures the committee again with the gateway text.
- CM-D6: each email keeps its promised date (pr) and delivery date (dl) instead of one date: B0 checks the
  labeled date in the field of its label.

Usage: LACRE_DIR=<lacre clone> py -3.12 tests/judge_gw_regression.py [--p2] [--out results/judge-gw-regression.txt]
"""
import collections
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tenet" / "tests"))
import judge_v2_stub_run as base  # noqa: E402

GW_PROFILE = {"promised_pattern": r"(?:Estimated delivery: |Expected delivery: )(20\d\d-[01]\d-[0-3]\d)\b",
              "delivery_pattern": r"(?:delivered on )(20\d\d-[01]\d-[0-3]\d)\b", "min_key_bits": 1024}


def gw_text(body_text):
    return body_text.replace("\r\n", "\n").strip()


def run_b3(rep, stats):
    """base.run_b3 with the B3 answers replayed on the gateway text (gw_text)."""
    rows = [json.loads(line) for line in base.B3_FILE.read_text(encoding="utf-8").splitlines()]
    by = {(r["pass"], r["mail"], r["question"], r["model"]): r for r in rows}
    votes = collections.defaultdict(dict)
    for r in rows:
        votes[(r["pass"], r["mail"], r["question"])][r["model"]] = r["answer"]
    t_ok = t_n = d_ok = d_n = 0
    diffs = []
    for n in sorted({r["pass"] for r in rows}):
        for m in base.MAIL["positives"]:
            w = base.World("mail")
            body_text = gw_text(m["body"].encode("latin-1").decode("utf-8"))
            prompts = {base.mail_llm_v3.build_prompt("type", body_text): "type",
                       base.mail_llm_v3.build_prompt("date", body_text): "date"}

            def lookup(prompt, n=n, m=m, prompts=prompts):
                q = prompts.get(prompt)
                if q is None:
                    return None
                stats["prompts_m"] += 1
                return q, [base.recorded_answer(by.get((n, m["id"], q, x))) for x in base.MODELS]
            claim = base.claim_mail(m["claim_order"])
            got = w.judge(claim, [w.ev(m["id"])], base.MAIL_DAY, lookup)
            mine = {q: v for q, v, _ in w.committee.log}
            if got[0] == "ok":
                stats["verdicts"].append((w.verdict(claim), w.state(claim)))
            exp_t = base.majority([votes.get((n, m["id"], "type"), {}).get(x) for x in base.MODELS])
            t_n += 1
            if mine.get("type") == exp_t:
                t_ok += 1
            else:
                diffs.append("%s pass %d type %s / %s" % (m["id"], n, mine.get("type"), exp_t))
            if (n, m["id"], "date") in votes:
                exp_d = base.majority([votes[(n, m["id"], "date")].get(x) for x in base.MODELS])
                d_n += 1
                if mine.get("date") == exp_d:
                    d_ok += 1
                else:
                    diffs.append("%s pass %d date %s / %s" % (m["id"], n, mine.get("date"), exp_d))
            elif "date" in mine:
                diffs.append("%s pass %d: the contract asked the date and B3 did not" % (m["id"], n))
                d_n += 1
            stats["det_fail"] += w.committee.det_fail
            stats["formats"].update(w.committee.formats)
            stats["unknown_m"] += w.committee.unknown_prompts
    rep.metric("J2", "B3 replayed on the gateway text: type (of 180) and date (of 60)", t_ok + d_ok, t_n + d_n,
               "type %d/%d, date %d/%d %s" % (t_ok, t_n, d_ok, d_n, "; ".join(diffs[:5])))


def b0_tests():
    """base.b0_tests with the labeled date read in the field of its label (pr or dl)."""
    out = []
    for m in base.MAIL["positives"] + base.MAIL["negatives"]:
        w = base.World("mail")
        exp = m["expected_code"]
        answers = {"type": m["expected_type"] or "other"}
        if m.get("expected_date_b2"):
            y, mo, d = m["expected_date_b2"].split("-")
            answers["date"] = "%d|%d|%d" % (int(mo), int(d), int(y))
        elif m.get("expected_date") == "":
            answers["date"] = "||"
        claim = base.claim_mail(m["claim_order"])
        got = w.judge(claim, [w.ev(m["id"])], base.MAIL_DAY, base.scripted(answers))
        st = w.state(claim)
        es = st["emails"] if st else []
        if exp["usable"]:
            want = exp["fixed_dates"][0] if exp["fixed_dates"] else None
            good = (got[0] == "ok" and len(es) == 1 and es[0]["type"] == answers["type"]
                    and (want is None or want in (es[0]["pr"], es[0]["dl"])))
        else:
            good = got[0] == "ok" and es == [] and base.outcome(w, claim) == ("wait", "NOT_YET", 0, "signed emails required")
        out.append((m["id"], good, (got, es[:1])))
    return out


def setup():
    # Through Tenet's folder (tenet/../contracts): the same files, written by Tenet's harness relative to its root.
    # --p2 (read by Tenet's harness too): the subjective judge built for Bradbury Phase 2, v0.6 std lib names.
    subjective = "judge_subjective_gw_p2.py" if base.P2 else "judge_subjective_gw.py"
    base.CONTRACTS.update({"mail": base.ROOT / ".." / "contracts" / "judge_mail_gw.py",
                           "subjective": base.ROOT / ".." / "contracts" / subjective})
    base.MAIL["profile"].update(GW_PROFILE)
    for line in (ROOT / "contracts" / "ERRORS-gw.md").read_text(encoding="utf-8").splitlines():
        cells = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(cells) == 2 and cells[0][:1] in "MI" and cells[0][1:].isdigit():
            base.CODES[cells[0]] = cells[1]
    base.CODES["M5"] = base.CODES["M4"]
    base.run_b3 = run_b3
    base.b0_tests = b0_tests


if __name__ == "__main__":
    setup()
    sys.exit(0 if base.main() else 1)
