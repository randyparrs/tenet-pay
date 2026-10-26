# Tenet Pay

A checkout with buyer protection for online stores, on testnet. The buyer pays into an escrow on Arc. The payment goes
to the store when the hold ends, or back to the buyer if a judge on GenLayer decides a claim for them, using the store's
signed emails (verified on Lacre) and the refund terms the store registered.

Tenet Pay is the gateway built on [Tenet](https://github.com/randyparrs/Tenet): the same escrow contract and judge
templates, now open to any store that registers. Tenet is included as a git submodule (`tenet/`) at a fixed commit.

## Live on testnet

| What | Where |
|---|---|
| Home (links to everything below) | https://paytenet.site |
| Checkout | https://paytenet.site/pay/ (a store sends the buyer to `paytenet.site/#pay/<order>`, which opens it) |
| My orders (claims, refunds, withdrawals) | https://paytenet.site/orders/ |
| How it works | https://paytenet.site/how/ |
| For stores (registration, orders, balance, terms) | https://merchants.paytenet.site |
| Example store | https://techshopping.site |
| Gateway API (Cloudflare Worker `tenet-gateway`) | https://tenet-gateway.randyparra.workers.dev |

The example store sells three products, each with a test scenario: the earbuds arrive one day late, the charger is not
the one described and the phone case never arrives. Payments use test USDC on Arc Testnet and the answer and proof
windows are 5 minutes, so a whole claim fits in one visit.

## Contracts

| Contract | Network | Address | Deployed |
|---|---|---|---|
| Escrow (Tenet's `evm/demo/RefundEscrow.sol`, 5 minute windows) | Arc Testnet (chain 5042002) | [`0x17FBCDF5c1780DfE29dcE5aFf2E3D3921d393798`](https://explorer.testnet.arc.io/address/0x17FBCDF5c1780DfE29dcE5aFf2E3D3921d393798) | [tx](https://explorer.testnet.arc.io/tx/0x3c731bae01b5e098488789271d5ca08086be55ed609c7f79f542ae5c32b75c79), block 68349809 |
| Email judge (`contracts/judge_mail_gw.py`) | GenLayer Bradbury | `0x87B67B8496be2481d51353cd552DFB26698af346` | [tx](https://explorer-bradbury.genlayer.com/tx/0xac29ceb444d7163dc937224dec66f4280bba06af078f6731c37a1da1b5b0f0e7) |
| Subjective judge (`contracts/judge_subjective_gw.py`) | GenLayer Bradbury | `0x766F9d7f98675E5fa7e1B7DE832b66ceE8286936` | [tx](https://explorer-bradbury.genlayer.com/tx/0x1c24959dba61a02a034834eb59c5a998c6b990b7544990d95465f65ff2c9dec7) |

USDC on Arc Testnet: `0x3600000000000000000000000000000000000000`. The store emails are attested with Lacre's deployed
contracts on Bradbury. TechShopping's registered terms hash is
`0xab9996d0149a7f43943d340749a4036b7ef5440547e53fca7c40abec650a98e9` (30 day hold).

## What is in this repository

| Path | What it is |
|---|---|
| `worker/` | The gateway Worker: store registration (DNS TXT, terms draft, signed confirmation, test email, DKIM key, judges, escrow), orders and checkout data, store emails to Lacre, claims to the judges, verdicts to the escrow, webhooks. One Durable Object holds the state. |
| `site/` | paytenet.site: the home page, the checkout (`pay/`), My orders, How it works, and `app/`, which only redirects the links of an earlier page. |
| `merchants-site/` | merchants.paytenet.site: the store panel. |
| `techshopping/` | The example store: its page and its own Worker (orders, the order emails it sends to Tenet, the webhook it receives). |
| `contracts/` | The two gateway judges as deployed, and the script that builds them from Tenet's templates. |
| `tests/`, `worker/test/` | The local rehearsal and the tests (below). |
| `cases/`, `data/` | The policies and the recorded readings of the terms drafting test (F1). |
| `build_site.py` | Copies the shared files into the pages (`terms.js`, `tenet.js`, the Circle SDK), so they cannot drift, and writes the home page's three numbers from Tenet's site data (`tenet/site/data/tenet.json`). |
| `setup.py` | The testnet setup of the gateway (key, escrow, judges), one command at a time. |

What is in this repository is what runs on the sites and Workers above: the page files are served byte for byte as they
are here, and `python contracts/build_judge_gw.py --check` rebuilds both judges from the pinned Tenet templates and
compares them byte for byte with the deployed files.

## Terms drafting (F1)

When a store registers, a fixed model (Llama 3.3 70B through OpenRouter) drafts the structure of its refund terms from
the policy the store pastes; the store checks every field and signs. The drafting was measured on 21 policies. Three of
them were the published policies of real stores and are not included here; `cases/f1-policies.json` and
`data/local-f1.jsonl` hold the other 18 and their recorded readings, and `worker/test/f1.test.mjs` checks that the
Worker builds the same prompt and reads the same structures.

## Tests

Requirements: Node 24, Python 3.12, Foundry, and a clone of [Lacre](https://github.com/eudomar500/lacre) at the commit in
`NOTICE.md` (`LACRE_DIR`). From the repository root:

```
git submodule update --init --recursive
npm ci
(cd tenet/evm && forge build && FOUNDRY_PROFILE=demo forge build)
node worker/test/terms.test.mjs
node worker/test/mime.test.mjs
node worker/test/f1.test.mjs
python contracts/build_judge_gw.py --check
python tenet/tools/lacre_boot.py tests/judge_gw_regression.py
node worker/test/rehearsal.mjs
```

The rehearsal runs the gateway Worker's core against an escrow on a local chain (anvil), the two judges as built in
Lacre's simulated GenVM SDK, and the three pages and the example store in a DOM, with no keys and no network. The same
steps run in CI on every push.

## Limits

Testnet only. The answer and proof windows are 5 minutes (production would use the store's real deadlines). The judges
do not apply preconditions or excluded causes yet, so a store cannot register terms with them.

## License

MIT, see `LICENSE`. Third-party work is listed in `NOTICE.md`.
