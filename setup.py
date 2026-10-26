"""Testnet setup of Tenet's payment gateway, one command and at most one
transaction at a time, after relayer/demo_setup.py. Nothing here touches the live test or the Demo Shop.

    <Lacre's Python> tools/lacre_boot.py setup.py <command>

  key                        creates E2E_KEYS/gateway.env (the gateway key: relayer of the gateway escrow, owner of
                             the gateway judges, sender of Lacre and KeyCache transactions); prints only its address
  fund-gen <GEN> [--dry]     GEN on Bradbury from the signer to the gateway key
  fund-usdc <USDC> [--dry]   USDC (Arc's gas) on Arc from the signer to the gateway key
  escrow-preview             what escrow-deploy will deploy (read only)
  escrow-deploy              the gateway escrow: evm/out-demo (5-minute windows, CM-D9), owner the signer, relayer the
                             gateway key, guardian, USDC cap 5.00, verdict delay 2 minutes
  judge-deploy <mail|subjective> [--dry]   contracts/judge_*_gw.py, signed by the gateway key (its owner)
  judge-recover-deploy <mail|subjective>   resumes waiting for a deploy already sent (read only)
  judge-confirm-deploy <mail|subjective>   waits for FINALIZED; same code, schema, prompt_hash and owner
  data                       writes the addresses into worker/src/gateway-data.json (local file)
  isolation <before|after>   CM11, read only: the live and Demo Shop contracts (code, owners, terms) to compare
  status                     what is deployed (read only)

Logs: results/gateway-log.jsonl (Arc), results/gateway-judges-log.jsonl (Bradbury); state relayer/gateway-state.json.
"""
import hashlib
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TENET = ROOT / "tenet"
os.environ["E2E_STATE"] = str(ROOT / "results" / "gateway-state.json")
os.environ["E2E_LOG"] = str(ROOT / "results" / "gateway-log.jsonl")
sys.path[:0] = [str(TENET / "relayer"), str(TENET / "tools"), str(TENET / "arbiter")]
import e2e as E  # noqa: E402  (Arc: signer, guardian, sends and logs; reads SIGNER_ENV now)

KEY = E.KEYS / "gateway.env"
E.KEY_FILES["gateway"] = (KEY, "PRIVATE_KEY")
ART = TENET / "evm" / "out-demo" / "RefundEscrow.sol" / "RefundEscrow.json"
CAP = 5_000_000
VERDICT_DELAY = 120
GW = {"mail": ROOT / "contracts" / "judge_mail_gw.py", "subjective": ROOT / "contracts" / "judge_subjective_gw.py"}
DATA = ROOT / "worker" / "src" / "gateway-data.json"
BRADBURY_RPC, BRADBURY_ID = "https://rpc-bradbury.genlayer.com", 4221


def judges():
    """tools/judge_send.py with the gateway key as the sender, the gateway judges and their own log."""
    os.environ["SIGNER_ENV"] = str(KEY)
    import judge_send as J
    J.SIGNER_ENV = KEY
    J.CONTRACT = dict(GW)
    J.LOG = ROOT / "results" / "gateway-judges-log.jsonl"
    J.STOP = ROOT / "results" / "gateway-judges-STOP"
    J.CASES = {"router": E.BR["router"], "cases": []}
    views = ["get_claim", "get_merchant", "get_verdict", "judge", "owner", "prompt_hash", "set_merchant", "versions"]
    J.EXPECTED_METHODS = {"mail": sorted(views + ["router"]), "subjective": sorted(views)}
    return J


def cmd_key():
    from eth_account import Account
    if KEY.exists():
        print("gateway key already exists, not overwritten:", E.address("gateway"))
        return
    acct = Account.create()
    k = acct.key.hex()
    with open(KEY, "x", encoding="utf-8") as fh:
        fh.write("PRIVATE_KEY=%s\n" % (k if k.startswith("0x") else "0x" + k))
    print("gateway key created in %s: %s" % (KEY, acct.address))


def cmd_fund_gen(amount, dry):
    from web3 import Web3
    amount = Decimal(amount)
    if not Decimal("0") < amount <= Decimal("5"):
        sys.exit("amount between 0 and 5 GEN")
    w3 = Web3(Web3.HTTPProvider(BRADBURY_RPC, request_kwargs={"timeout": 60}))
    if w3.eth.chain_id != BRADBURY_ID:
        sys.exit("unexpected chain id")
    signer, to = E.account("signer"), E.address("gateway")
    gen = lambda a: Decimal(w3.eth.get_balance(a)) / Decimal(10**18)  # noqa: E731
    print("signer  %s  %s GEN\ngateway %s  %s GEN" % (signer.address, gen(signer.address), to, gen(to)))
    tx = {"from": signer.address, "to": to, "value": int(amount * 10**18), "chainId": BRADBURY_ID, "nonce": w3.eth.get_transaction_count(signer.address)}
    gas = w3.eth.estimate_gas(tx)
    base, tip = w3.eth.get_block("latest")["baseFeePerGas"], w3.to_wei(2, "gwei")
    tx.update(gas=gas * 2, maxFeePerGas=base * 2 + tip, maxPriorityFeePerGas=tip)
    print("transfer %s GEN, gas estimate %d" % (amount, gas))
    if dry:
        print("--dry: nothing sent")
        return
    h = w3.eth.send_raw_transaction(signer.sign_transaction(tx).raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=300)
    print("SENT tx %s, status %d; gateway now %s GEN" % (w3.to_hex(h), r["status"], gen(to)))


def cmd_fund_usdc(amount, dry):
    amount = Decimal(amount)
    if not Decimal("0") < amount <= Decimal("10"):
        sys.exit("amount between 0 and 10 USDC")
    w3, signer, to = E.w3(), E.account("signer"), E.address("gateway")
    bal = lambda a: Decimal(w3.eth.get_balance(a)) / Decimal(10**18)  # noqa: E731  (Arc: native USDC, 18 decimals)
    print("signer  %s  %s USDC\ngateway %s  %s USDC" % (signer.address, bal(signer.address), to, bal(to)))
    tx = {"from": signer.address, "to": to, "value": int(amount * 10**18), "chainId": E.CHAIN_ID, "nonce": w3.eth.get_transaction_count(signer.address), **E.fees()}
    tx["gas"] = w3.eth.estimate_gas(tx) * 2
    print("transfer %s USDC" % amount)
    if dry:
        print("--dry: nothing sent")
        return
    h = w3.eth.send_raw_transaction(signer.sign_transaction(tx).raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=120)
    E.append({"op": "fund_usdc", "to": to, "amount": str(amount), "tx": w3.to_hex(h), "status": r["status"]})
    print("SENT tx %s, status %d; gateway now %s USDC" % (w3.to_hex(h), r["status"], bal(to)))


def art():
    if not ART.exists():
        sys.exit("build the 5-minute escrow first: py -3.12 tools/make_demo_escrow.py, then in evm/: FOUNDRY_PROFILE=demo forge build")
    a = json.loads(ART.read_text(encoding="utf-8"))
    if a["metadata"]["sources"].get("demo/RefundEscrow.sol") is None:
        sys.exit("%s was not built from evm/demo/RefundEscrow.sol" % ART)
    return a


def cmd_escrow_preview():
    a = art()
    print("bytecode sha256 %s" % hashlib.sha256(a["bytecode"]["object"].encode()).hexdigest())
    print("owner %s (signer), relayer %s (gateway key), guardian %s" % (E.address("signer"), E.address("gateway"), E.address("guardian")))
    print("token USDC %s, cap %.2f USDC per order, verdict delay %d s, windows 5 minutes (5-minute build)" % (E.USDC, CAP / 1e6, VERDICT_DELAY))


def cmd_escrow_deploy():
    E.ART = art()
    st = E.state()
    if st.get("escrow"):
        sys.exit("there is already a gateway escrow in the state: %s" % st["escrow"])
    signer, relayer, guardian = E.address("signer"), E.address("gateway"), E.address("guardian")
    c = E.w3().eth.contract(abi=E.ART["abi"], bytecode=E.ART["bytecode"]["object"])
    receipt = E.send("signer", c.constructor(signer, relayer, guardian, [E.USDC], [CAP], VERDICT_DELAY), "deploy")
    st.update(escrow=receipt["contractAddress"], deploy_block=receipt["blockNumber"], usdc=E.USDC)
    E.save_state(st)
    e = E.escrow()
    got = (e.functions.owner().call(), e.functions.relayer().call(), e.functions.guardian().call(), e.functions.capPerOrder(E.USDC).call(),
           e.functions.verdictDelay().call(), e.functions.RESPONSE_WINDOW().call(), e.functions.CLOSING_WINDOW().call(), e.functions.PROOF_WINDOW().call())
    want = (signer, relayer, guardian, CAP, VERDICT_DELAY, 300, 300, 300)
    print("GATEWAY ESCROW %s; parameters %s" % (receipt["contractAddress"], "as expected" if got == want else "DIFFERENT: %s" % (got,)))
    if got != want:
        E.stop("gateway escrow parameters differ from the expected ones")


def cmd_judge(cmd, kind, dry):
    J = judges()
    if cmd == "judge-deploy":
        J.cmd_deploy(kind, dry)
    elif cmd == "judge-recover-deploy":
        J.cmd_recover_deploy(kind)
    else:
        J.cmd_confirm_deploy(kind)
        d = J.deployed(kind)
        _, client, net = J.connect(dry=True)
        owner = str(J.chain.read(net, client, d["address"], "owner", [], J.FINAL)).lower()
        ok = owner == E.address("gateway").lower()
        print("owner %s: %s" % (owner, "the gateway key, as expected" if ok else "NOT the gateway key"))
        if not ok:
            J.STOP.write_text("the %s judge's owner is not the gateway key" % kind, encoding="utf-8")
            sys.exit("STOP: wrong owner")


def cmd_data():
    J = judges()
    st = E.state()
    d = json.loads(DATA.read_text(encoding="utf-8"))
    d.update(escrow=st.get("escrow", ""), deploy_block=st.get("deploy_block", 0),
             judges={k: (J.last(op="deploy", kind=k, state="final") or {}).get("address", "") for k in ("mail", "subjective")})
    DATA.write_text(json.dumps(d, indent=1) + "\n", encoding="utf-8")
    print("gateway-data.json: escrow %s (block %s), judges %s" % (d["escrow"], d["deploy_block"], d["judges"]))


LIVE = {"escrow": "0x5Bf18C9B66dF20BF2D30e08b561f65de73fA1E2D", "demo_escrow": "0x185D7aaFE85823a2B91D00735CF9f312E1dAc709",
        "mail": "0x7e3251e7A9479280a6b8c93FD2E852291abd105c", "subjective": "0x2a0126530321FF7886A568b9439d3535A27EfA91",
        "demo_mail": "0x503E73e0Fb2B85C2027Eef457417796D499511E4", "demo_subjective": "0x68e180057AE598301b94a0737309fE00a1ca7D3f"}


def cmd_isolation(when):
    """CM11: code hashes and owners of the four live and Demo Shop judges, code hashes and terms of the two escrows."""
    import judge_send as J
    _, client, net = J.connect(dry=True)
    out = {}
    for k in ("mail", "subjective", "demo_mail", "demo_subjective"):
        code = J.chain.rpc_read(net, "gen_getContractCode", [{"address": LIVE[k]}]).get("result", "")
        out[k] = {"code_sha256": hashlib.sha256(code.encode()).hexdigest(), "owner": str(J.chain.read(net, client, LIVE[k], "owner", [], J.FINAL))}
    w3 = E.w3()
    for k in ("escrow", "demo_escrow"):
        out[k] = {"code_sha256": hashlib.sha256(bytes(w3.eth.get_code(LIVE[k]))).hexdigest()}
    path = ROOT / "results" / ("gateway-isolation-%s.json" % when)
    path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("CM11 %s: %s" % (when, path.name))
    other = ROOT / "results" / "gateway-isolation-before.json"
    if when == "after" and other.exists():
        print("unchanged since before:", json.loads(other.read_text(encoding="utf-8")) == out)


def cmd_status():
    st = E.state()
    print("gateway key:", E.address("gateway") if KEY.exists() else "not created")
    print("gateway escrow:", st.get("escrow") or "not deployed")
    J = judges()
    for kind in ("mail", "subjective"):
        d = J.last(op="deploy", kind=kind)
        print("judge %-10s %s %s" % (kind, (d or {}).get("address") or "not deployed", (d or {}).get("state", "")))


def main():
    a = sys.argv[1:]
    dry = "--dry" in a
    a = [x for x in a if x != "--dry"]
    cmd = a[0] if a else ""
    if cmd == "key":
        cmd_key()
    elif cmd == "fund-gen" and len(a) == 2:
        cmd_fund_gen(a[1], dry)
    elif cmd == "fund-usdc" and len(a) == 2:
        cmd_fund_usdc(a[1], dry)
    elif cmd == "escrow-preview":
        cmd_escrow_preview()
    elif cmd == "escrow-deploy":
        cmd_escrow_deploy()
    elif cmd in ("judge-deploy", "judge-recover-deploy", "judge-confirm-deploy") and len(a) == 2 and a[1] in GW:
        cmd_judge(cmd, a[1], dry)
    elif cmd == "data":
        cmd_data()
    elif cmd == "isolation" and len(a) == 2 and a[1] in ("before", "after"):
        cmd_isolation(a[1])
    elif cmd == "status":
        cmd_status()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
