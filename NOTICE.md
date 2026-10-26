# Notice

Tenet Pay includes or builds on the following work.

## Tenet

- Source: https://github.com/randyparrs/Tenet (git submodule `tenet/`, pinned commit)
- License: MIT, Copyright (c) 2026 randyparrs
- What Tenet Pay uses: the escrow contract (`evm/demo/RefundEscrow.sol`), the judge templates the gateway judges are
  built from, the shared Worker helpers (`worker/src/util.js`), the Circle wallet script, and the tests and tools the
  rehearsal runs on. Tenet's own third-party notices are in `tenet/NOTICE.md`.

## Lacre

- Source: https://github.com/eudomar500/lacre
- License: MIT, Copyright (c) 2026 Insidr Labs
- What Tenet Pay uses: the deployed Lacre contracts on GenLayer Bradbury (Router, Verifier and KeyCache) for DKIM email
  attestations, and, in the tests, Lacre's simulated GenVM SDK and tools at commit
  d2cb1fc1b19b9b31af7ef1b561221f447ec21838 (a separate clone, `LACRE_DIR`; no Lacre code is copied here; its mark is listed under Logos).

## Circle Web SDK

- Source: https://www.npmjs.com/package/@circle-fin/w3s-pw-web-sdk (version 1.1.11)
- License: Apache License 2.0
- What Tenet Pay uses: `site/circle-sdk.js`, Tenet's bundle of the SDK copied unchanged by `build_site.py` (see
  `tenet/NOTICE.md` for how it is built). It lets a buyer continue with a Circle wallet instead of a browser wallet.

## npm packages

- viem 2.55.4 and genlayer-js 1.2.0 (MIT), bundled into the gateway Worker.
- linkedom 0.18.13 (ISC), used only by the tests.

## Logos

The home page (`site/index.html`) shows the marks of the three projects Tenet Pay is built on, unchanged, in
`site/logos/`. They belong to their owners and are used only to name those projects.

- `arc.svg`: Arc Network icon (white), from Arc's logo kit.
- `genlayer.svg`: GenLayer mark (white), from https://www.genlayer.com/brand.
- `lacre.svg`: Lacre's icon, from https://lacre.in-sidr.xyz (Insidr Labs).
