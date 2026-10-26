"""Writes worker/src/f1-prompt.json from arbiter/policy_v2.py (the prompt F1 measured, PROMPT_SHA256 81db1190),
so the Worker's draft uses the measured text and cannot drift from it.
Usage: py -3.12 worker/build_f1_prompt.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tenet" / "arbiter"))
import policy_v2  # noqa: E402

out = {"prompt": policy_v2.PROMPT, "prompt_sha256": policy_v2.PROMPT_SHA256, "max_policy": policy_v2.MAX_POLICY,
       "model": "meta-llama/llama-3.3-70b-instruct", "temperature": 0.7, "max_tokens": 400}
(Path(__file__).parent / "src" / "f1-prompt.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
print("f1-prompt.json, prompt sha256", policy_v2.PROMPT_SHA256[:16])
