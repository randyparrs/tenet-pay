# Roadmap

What Tenet Pay does today, on testnet, and what comes next.

## Done

- **Checkout with buyer protection.** The buyer pays into an escrow on Arc; the payment goes to the store when the hold ends, or
  back to the buyer if the judge decides a claim for them.
- **Store registration** with a DNS proof of the domain and terms drafted by AI from the store's refund policy, always confirmed by
  the store.
- **Store panel** for orders, answers to claims, the balance and the terms.
- **Signed webhooks** to the store.
- **Circle wallet with Google** for buyers.
- **Real DKIM signed emails** from the store to a Tenet address for each order.
- **HTML email reading.**
- **Versioned terms.**
- **Judges on Bradbury Phase 2:** both are deployed; the email judge reads Lacre on Phase 2 (fork randyparrs/lacre).

## Next

- **Orvyn:** buyer protection for AI agents that shop. In progress: [orvyn.paytenet.site](https://orvyn.paytenet.site) and
  [randyparrs/orvyn](https://github.com/randyparrs/orvyn).
- **Delivery verification** for "not delivered" claims: the GenLayer judge reads the carrier's public tracking. Fallback: the
  carrier's emails, verified with Lacre.
- **Appeals:** either side can appeal a verdict with a deposit, and a larger GenLayer committee judges it again.
- **The "late" path again,** once Lacre is live on Bradbury Phase 2.
- **Escrow v4:** a fee on what is released to the store, and orders signed by the store.
- **Email bodies by URL,** for real store emails of any size. Required before the first real store.
- **Preconditions and exclusions** supported in the judges.
- **On chain store registry,** and 2048 bit DKIM keys for real stores.
