# Wallet architecture (integration reference)

`C:\Data\MoneyMatch\wallet.js` is the integration point for real money. It is **ledger-based, funding-source-agnostic, integer-cents, atomic** (conditional `UPDATE ... WHERE balance_cents >= ?` prevents overdraw; append-only `wallet_transactions` with `type` + `ref`). Real money = **new tx types** (`deposit`, `withdrawal`, `deposit_reversal`, `deposit_fee`, `withdrawal_fee`) + an **idempotent external-payment table keyed by provider event id** — extend the existing `credit`/`debit(userId, cents, type, ref)` API, don't rewrite.

Related: `liveMarkets.js` = parimutuel ~5% rake (no house outcome risk); Futures = 5% baked vig (house is counterparty). Keep **USD/CAD cents as the internal unit** for both fiat and crypto; convert BTC at the edge (avoids float price risk + captures tax FMV).

> Note for any real-money build: **SQLite is a single-writer SPOF** — fine for play money, but migrate to Postgres (row-level locking) before real-money volume.
