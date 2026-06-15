# Monetization / fee structure (settled: percentage, not flat)

**Fee model = percentage rake, NOT a flat fee.** Do not re-open flat-vs-% — it's settled.
- **Live:** ~5% parimutuel takeout off the pool, with a per-bet **minimum floor** (`max(5%, ~$0.05)`); no cap needed at the current $500 max stake.
- **Futures:** 5% baked overround — low vs. ~10% sportsbook hold; raise toward 6–8% only after observing book balance (fixed-odds carries house risk if unbalanced).
- **Why:** flat fees are regressive ($0.25 = 12.5% of a $2 bet, 0.05% of a $500 bet). 5% sits at the low/player-friendly end of real takeout (horse 15–30%, sportsbook ~10%, poker/Betfair ~5%) with headroom.
- Treat **rake %, per-bet minimum, and an (unused) cap as per-product config**, not hardcoded.

**Fee-vs-payment-cost separation:** deposit/withdrawal fees must be a **separate ledger line** from wager rake, sized per rail (0% Lightning/crypto; surcharge to cover ~3–7% on cards). A single-bet card cycle eats the whole 5% rake (~breakeven); on Lightning the house keeps ~80%. This is the monetization argument for the crypto rail.

**Implementation:** record rake as its own `debit` type (`rake`/`vig`) with `ref` → pool/match id, distinct from `deposit_fee`/`withdrawal_fee`. Use round-up + floor so pools reconcile: `sum(stakes) = sum(payouts) + sum(rake)`.
