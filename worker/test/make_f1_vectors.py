"""Vectors for worker/test/f1.test.mjs: SHA-256 of policy_v2.build_prompt for the 21 policies of F1.
Usage: py -3.12 worker/test/make_f1_vectors.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tenet" / "arbiter"))
import policy_v2  # noqa: E402

pol = json.load(open(ROOT / "cases" / "f1-policies.json", encoding="utf-8"))["policies"]
out = [{"id": p["id"], "policy": p["policy"], "prompt_sha256": hashlib.sha256(policy_v2.build_prompt(p["policy"]).encode()).hexdigest()}
       for p in pol]
json.dump(out, open(Path(__file__).with_name("f1-vectors.json"), "w", encoding="utf-8"))
print(len(out), "policies")
