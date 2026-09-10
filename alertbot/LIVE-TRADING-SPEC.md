# LIVE-TRADING-SPEC.md — going from paper to real money, safely

> **STATUS: DESIGN ONLY. No order-placing code exists yet, and none will be written until
> this spec is reviewed and each rollout stage below is explicitly approved.** This document is
> the contract. Read it against `CLAUDE.md` (the charter) and `EDGE-REPORT.md` (the measured edge).

---

## 0. Prime directives (non-negotiable — everything else serves these)

1. **Default OFF.** Live execution is inert unless *two independent* switches are on: an env flag
   (`LIVE_TRADING=on`) **and** a runtime "ARMED" toggle that auto-expires. Neither alone does anything.
2. **Dry-run first, always.** Every live path ships behind `dryRun: true` — it computes and *logs the
   exact order it would place, and places nothing*. Real orders require flipping a **separate** hard flag.
3. **Fail closed.** Any error, disconnect, ambiguity, reconciliation mismatch, or missing data → **halt
   new entries, keep protective stops, alert, do not guess.** The system never "assumes" its way forward.
4. **Paper stays the source of truth.** Live is an *additional* execution layer on the *same* signals the
   `filtered` paper account already takes. It never alters the strategy, the paper accounts, or the two-
   account experiment. If live and paper ever disagree, that's a bug → halt.
5. **The edge is modest and regime-capped.** Per `EDGE-REPORT.md`, the return is small and only present
   shorting downtrends; regime-filtering cuts drawdown, not risk of loss. Going live is only rational on
   the **`filtered` (bear-only)** config, **after it shows a real live *paper* track record** (today it
   has 0 trades). Live can lose real money even if the code is perfect.

---

## 1. Goals / non-goals

**Goals**
- Mirror, on Binance USDⓈ-M futures, exactly the entries/exits the `filtered` paper account decides.
- Enforce hard, layered risk limits and a one-action kill switch.
- Keep positions *always protected* by exchange-side stops, even if the bot process dies.

**Non-goals (explicitly out of scope)**
- No new strategies, no discretionary/manual orders through the bot, no averaging-down/martingale.
- No leverage beyond a hard cap (default ≤ 3×).
- **No withdrawal or transfer capability, ever.** The bot cannot move funds off the account.
- No change to paper behavior, and no live trading of the unfiltered `strategy` account.

---

## 2. Credentials & permissions (the user owns these — the assistant never touches them)

- Binance API key with **Futures Trade** permission **only**. **Withdrawals permission MUST be disabled.**
- **IP-whitelist** the key to the bot's host.
- Keys live in **environment variables only** (`BINANCE_KEY`, `BINANCE_SECRET`). Never in code, `config.ts`,
  persisted files, logs, or anything sent to the frontend/dashboard. The dashboard shows *state*, never keys.
- Strongly recommend a **dedicated sub-account** funded with only risk-capital you can lose.
- The assistant will **not** ask for, store, log, or enter keys, and will **not** place trades on your behalf.

---

## 3. Architecture

- New module `src/live.ts`, **inert by default**. It subscribes to the *same* decision the engine makes for
  the `filtered` account in `paper.ts` (`paperOpen`/close for that account) and mirrors it — a `LiveAccount`
  that shadows `filtered`'s decisions. It does **not** re-derive signals; single source of truth.
- **Order lifecycle per trade:**
  1. Entry order (LIMIT at level or MARKET, per `plan`/`confirmEntryAtClose`).
  2. On fill → immediately attach **exchange-side** `STOP_MARKET` (reduceOnly) stop-loss **and** a
     take-profit, sized to the *actual filled quantity*. Protection must exist on the exchange, not just in
     the bot's memory, so a crash never leaves a naked position.
  3. Manage (break-even/trail mirror the paper exit rules) → close (reduceOnly), book realized P&L.
- **Reconciliation loop** (every cycle): fetch exchange positions + open orders, diff against the intended
  live state; **any mismatch → HALT + alert**, never silent-correct into a trade.
- Persist intended live state to disk (`data/live.json` + `.bak`), same discipline as paper.

---

## 4. The safety rails (the heart of this spec)

**Arming**
- `LIVE_TRADING=on` (env) **AND** runtime `ARMED` (dashboard action with a typed confirmation phrase).
- `ARMED` **auto-disarms** after `autoDisarmHours` and on every process restart. You re-arm deliberately.

**Kill switch (single action, always available)**
- Cancels all open orders, optionally **flattens** all live positions (`flattenOnKill`), and disarms.
- Reachable via dashboard button, an env/file flag, and (recommended) a keyboard shortcut in the terminal.
- **Dead-man protection:** because SL/TP live on the exchange, loss of the bot↔exchange connection for
  `> deadmanSeconds` leaves positions protected by the resting stop, and blocks all new entries.

**Position caps**
- `maxConcurrent` positions, `maxPositionUsd` notional per position, `maxLeverage` (hard), one position/symbol.

**Loss halts (each halts *new entries*; drawdown/consecutive also *disarm*)**
- `maxDailyLossUsd` (resets at UTC/IST day), `maxDrawdownPct` from live peak, `maxConsecutiveLosses`.

**Per-order sanity (reject the order, log why)**
- Price sanity (reject if entry deviates > X bps from mark), min-notional, tick/step-size rounding from
  `exchangeInfo`, **slippage guard** (reject MARKET fills beyond `slippageGuardBps`), spread-too-wide guard.
- **Idempotency:** deterministic `newClientOrderId` per intended order so retries can't double-submit.
- Rate-limit aware with exponential backoff; respect Binance weight limits.

**Regime gate**
- Reuse `marketRegimeBlocks()` — live enters **only** in the (causal, trailing) downtrend the `filtered`
  account trades. Never bull/flat. This is the whole point of mirroring `filtered`, not `strategy`.

---

## 5. Binance USDⓈ-M order details (implementation notes for later)

- One-way position mode. Set margin type + leverage per symbol at arm time and **verify** the echo.
- Entry: `LIMIT` (GTC) at the plan level, or `MARKET` when `confirmEntryAtClose` fills at close.
- Stop-loss: `STOP_MARKET`, `reduceOnly=true`, `closePosition` where appropriate.
- Take-profit: `TAKE_PROFIT_MARKET` (or laddered TP1/2/3), `reduceOnly=true`.
- Round price→tickSize, qty→stepSize; enforce `minNotional`. Handle **partial fills** — SL/TP quantity must
  track the filled size, and top-ups/cancels must be reduceOnly.
- **Funding cost is real and NOT modeled in paper** — surface it in the live P&L so paper-vs-live is honest.

---

## 6. Crash recovery & reconciliation

- On startup while armed: fetch positions + open orders; **adopt** known ones, **flatten or alert** on
  unknown ones per policy; **never blindly re-enter** a position from persisted intent.
- Protective orders on the exchange are the safety net across restarts.

---

## 7. Observability

- Every live action logs *intended → actual → exchange response* to a dedicated live log + a
  Telegram/desktop alert on entries, exits, halts, and kill events.
- Dashboard **LIVE panel** (visually separated, amber, never green-"safe"): armed/dry-run state, live
  positions vs intended, today's realized live P&L (incl. funding), which halts have fired, kill button.
- The existing REAL/DEMO toggle only becomes meaningful when `armed && !dryRun`; a stray tap still can't
  place an order (typed-confirmation gate).

---

## 8. Config (all defaults are the safe values)

```ts
live: {
  enabled: false,           // AND env LIVE_TRADING === 'on' required
  dryRun: true,             // logs intended orders, places NONE
  account: 'filtered',      // mirror ONLY the bear-only account
  maxLeverage: 3,
  maxConcurrent: 2,
  maxPositionUsd: 50,       // start tiny; scale only per rollout
  maxDailyLossUsd: 25,
  maxDrawdownPct: 10,
  maxConsecutiveLosses: 4,
  slippageGuardBps: 15,
  priceSanityBps: 50,
  autoDisarmHours: 8,
  deadmanSeconds: 30,
  flattenOnKill: true,
}
```

---

## 9. Rollout stages (each fully proven before the next; any failed rail resets to the prior stage)

- **Stage 0 — Spec review.** You approve this document. *(← we are here)*
- **Stage 1 — Dry-run shadow.** Implement fully, `dryRun: true`. It logs the exact orders it *would* place
  and reconciles them 1:1 against the `filtered` paper account's decisions for ≥ 2 weeks. Verify: identical
  entries/exits, correct sizing, tick/step rounding, all rails *fire correctly in drills*. No real orders.
- **Stage 2 — Binance TESTNET.** Real order lifecycle, fake money. Verify entry, SL/TP attach, partial fill,
  close, reconciliation, kill switch, every halt, dead-man — each demonstrated at least once. ≥ 2 weeks.
- **Stage 3 — Mainnet, minimum size.** Exchange-minimum notional, one symbol, tiny risk capital, watched
  closely. Confirm live P&L (incl. funding) matches paper within tolerance.
- **Stage 4 — Scale toward the paper config** only after Stages 1–3 pass and after `filtered` has shown a
  positive *live paper* record over the agreed window. Never skip a stage; never scale on a hunch.

---

## 10. Pre-arm checklist (ALL must be true before Stage 3)

- [ ] `filtered` paper account has a **positive live track record** over the agreed window (it has 0 trades today).
- [ ] Market regime is one this strategy trades (bear); we do **not** arm into bull/flat.
- [ ] API key: **no withdrawal permission**, IP-whitelisted; dedicated sub-account funded with only risk capital.
- [ ] All rails unit-tested; kill switch, halts, and reconciliation **drilled** (each fired on purpose).
- [ ] You have read this spec and accepted the risk in writing.

---

## 11. Risks that remain even with a perfect implementation

Exchange outage / API change, liquidation, **funding costs (unmodeled in paper)**, slippage worse than
modeled, config fat-finger, correlated drawdown across SOL/BTC/ETH, black-swan gaps *through* the stop, and
the plain fact that **the measured edge is modest and regime-capped** — real capital can be lost. Nothing
here is a money printer; that's rule #3 of the charter.

---

## 12. What the assistant will and won't do

- **Will:** implement `live.ts` in the staged, default-off, dry-run-first way above, with tests, on your
  explicit per-stage go-ahead; wire the LIVE dashboard panel and kill switch; write the drills.
- **Won't:** handle/store/enter your API keys, place any trade for you, flip `dryRun` off, arm it, or skip a
  rollout stage. Those actions are yours, deliberately.

---

*Next step is yours: approve Stage 0, tell me any caps/values you want changed, and confirm you want Stage 1
(dry-run shadow, no real orders) built. Until then, REAL mode stays a label and the bot places nothing.*
