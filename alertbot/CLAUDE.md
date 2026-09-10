# CLAUDE.md — futures-alert-bot (`alertbot`)

> **Read this first.** It's the project's constitution + how-it-works, written so any AI or human picking
> up the work understands what we're building, the rules we hold, and how the bot actually takes trades.
> **Keep it updated** whenever a feature, strategy, config default, or measured finding changes.

---

## What this is

A **Binance USDⓈ-M FUTURES signal + paper-trading bot** in TypeScript (run via `tsx`, no build step).
It scans a watchlist each cycle, detects setups with *measured* strategies, simulates trades on a
fake-money (paper) account with real fees/slippage, and serves a live web dashboard. **The goal is an
HONEST proof-of-profit paper account** — prove a real edge on fake money first, only then consider live.

The definitive analysis of the bot's edge lives in **`EDGE-REPORT.md`** (read it for the numbers). This
file is the onboarding/architecture guide; that one is the measured findings.

---

## Core principles (the rules — non-negotiable)

1. **Math & reasoning, never emotion.** Every trade the bot takes is produced by a measured strategy, not a
   gut feeling. Every *change* we make must be backed by a backtest or clear, stated reasoning.
2. **Measure, don't guess.** Before trusting any change, measure it — there's a whole `npm run` suite for
   this. We have repeatedly caught "obviously good" ideas that the data proved wrong.
3. **Never autopilot; never blindly trust a signal.** Signals are probabilistic, not certainties. **Nothing
   here "can't lose."** Always give the honest caveat. The bot is a decision-support tool, not a money printer.
4. **Honest over optimistic.** Report the real numbers — including modest or negative ones. If a result is
   in-sample or small-sample, say so, and validate out-of-sample before recommending action. Correct your own
   earlier claims when new measurement contradicts them.
5. **Don't reshape founding features or money code unilaterally.** Behavior/strategy/live-config changes are
   the user's call — build them as **opt-in knobs (default off)**, measure, and recommend.
6. **The paper account must be trustworthy.** Honest fills, real tracked outcomes. It's the proof — it can't
   be allowed to lie (e.g. don't count fills that wouldn't happen).

---

## What the bot IS (the measured truth — full detail in `EDGE-REPORT.md`)

A **disciplined SHORT-BIASED TREND-FOLLOWER** with a **real but modest, edge-capped** return.
- It **earns shorting downtrends** (bear-regime shorts ≈ +0.2R/trade) and **bleeds in bull/flat/ranging
  markets**. It is *negatively* correlated to crypto (β ≈ −0.30 vs a SOL/BTC/ETH basket).
- Its return is **edge-capped**: regime-filtering, exit-tuning, and trade-selection were all tested and
  **none adds return** — they only control risk or overlap. The short-only character is **structural** (no
  long-side edge exists on this setup; oversold-bounce longs lose).
- **The one validated improvement:** a **bear-only market-regime filter** → ~½ the drawdown (risk control,
  *not* return). Widening the watchlist is **not** a growth win — the per-trade edge generalizes to alts, but
  correlated shorts concentrate risk, so the **narrow SOL/BTC/ETH filtered book is the best risk-adjusted**
  config (see `EDGE-REPORT.md` item 4). There is no validated return/growth lever.

---

## How the bot works (architecture + trade flow)

**Entry point:** `src/index.ts` runs the main loop. Each cycle, for every watchlist symbol: fetch candles →
run strategies + S/R touch/confirmation + confluence → dispatch alerts → paper-trade → update dashboard
state. It also computes the broad-market regime once per cycle (for the filter + dashboard badge).

**Trade flow (how a trade happens):**
`signal` (a strategy detector OR an S/R confirmation) → `plan.ts` builds entry/stop/target/size →
`evidence.ts` grades it (STRONG/OK/WEAK, from measured factor edges) → `paper.ts` `paperOpen` books it on
the fake account (respecting the regime filter + per-symbol cap) → managed each cycle (stop/target, ATR
trail) → closed, P&L booked (net of fees), journaled, shown on the dashboard with a ✓WON/✗LOST outcome.

**Key modules:**
- `strategies.ts` — each strategy is a `detect(ctx) => signal | null` plugin. **Enabled** (measured +EV):
  `breakout-retest`, `momentum-TSMOM`, `bollinger-reversion`. **Disabled by the audit** (break-even/negative):
  trend-pullback, vwap-reversion, sweep-reversal, standalone order-flow-imbalance, order-block. Plus the
  **founding feature**: S/R touch + confirmation-candle on consolidation ranges.
- `orderflow.ts` + `evidence.ts` — stack confluence factors (order flow, FVG, sweep, order-book wall, HTF,
  premium/discount, structure) into a graded "bet." **Order flow is the strongest factor.** Grades gate
  *notifications*, not paper entries.
- `regime.ts` (per-symbol regime) + `marketregime.ts` (causal broad-market basket regime for the filter).
- `paper.ts` (+ `paperexit.ts`) — the paper engine: compounding balance, taker fees, stop slippage,
  stop/target + trailing exits. `marketRegimeBlocks()` is the bear-only gate. **Runs TWO accounts in
  parallel off the same signal stream** (`ACCOUNTS`): `filtered` (bear-only, the measured-best config) and
  `strategy` (unfiltered — takes every signal in every regime). Each has its own compounding balance and
  persistence file (`data/paper-filtered.json`, `data/paper-strategy.json`); `filtered` migrates once from
  the legacy `data/paper.json` on first boot. This lets the *live* records settle the filter-vs-unfiltered
  question empirically instead of by argument. See "The two paper accounts" below.
- `plan.ts` — trade plans (entry/stop/target, R:R, position size). `buildConfirmPlan` handles confirmation
  fills (honest close-fill when `confirmEntryAtClose` is on).
- `server.ts` + `dashboard.ts` + `dashboardState.ts` — no-dep HTTP server + live dashboard (PWA) at
  `localhost:<port>`: S/R ladder, per-symbol regime, a broad-market **REGIME badge**, recent alerts with
  live outcomes, the paper account (with max drawdown), and the trade journal.
- `binance.ts` — Binance futures REST (klines/depth/OI/funding). Live price via **spot** WebSocket (the
  futures fstream delivers no frames on this network — known, not a bug).
- `indicators.ts`, `structure.ts`, `divergence.ts` — TA primitives (EMA/RSI/ATR/VWAP/pivots, SMC/ICT, RSI/CVD
  divergence). NB: the divergence alerts were **measured to be noise** — keep as chart context, don't trade them.
- `alphacore.ts` — shared engine for the research tools (signal replay, instrumented portfolio sim, OLS,
  deep-history fetch, `alignByTime`). Not used by the live bot.

---

## The paper accounts (parallel live experiments — now THREE, on TWO timeframes)

The dashboard's PAPER panel shows **three independent fake-money accounts**, each fed signals every cycle, so
their live records settle open questions with data, not opinion. Each account is tagged with a **`timeframe`**;
`paperOpen`/`paperEvaluate` take a `timeframe` arg and only touch accounts whose tag matches (so 1h signals reach
the legacy accounts and 4h signals reach `core_4h`):

| Account | `timeframe` | `applyFilter` | Behaviour | It answers |
|---|---|---|---|---|
| **`filtered`** | 1h | `true` | Opens only when the regime is in `config.market.allowedRegimes` (now bull/flat). | "Does regime gating help on 1h?" |
| **`strategy`** | 1h | `false` | Takes **every** 1h signal in every regime, unfiltered. | "What does the unfiltered 1h book earn?" |
| **`core_4h`** *(2026-07-15)* | 4h | `false` | The **unfiltered 4h momentum book** (`signalsAt` on 4h candles, crypto majors), the marginal candidate edge from the multi-TF sweep. Additive forward-test. | "Does the **marginal** 4h edge survive **live/forward**?" |
| **`core_4h_maker`** *(2026-07-18, OPT-IN)* | 4h | `false` | Same 4h signals as `core_4h`, but enters via a **resting maker LIMIT** (honest fill-gating: opens only if a later candle trades through the entry, else cancels; pays maker fee on entry). **Only exists when `config.paper.makerEntry.enabled` is true** (default OFF → absent). | "Does the measured **maker fee-swap** (~+0.009R, `makeredge`) show up **live** vs the market-entry `core_4h`?" |

- Each account sizes off **its own** compounding balance, books P&L independently, and persists to its **own** file
  (`data/paper-<id>.json` + `.bak`; `core_4h` → `data/paper-core_4h.json`). Same fee/slippage model.
- Implementation: `ACCOUNT_DEFS`/`ACCOUNTS` in `paper.ts` (each carries `timeframe`). `index.ts` runs the 1h scan
  (`checkSymbol`, watchlist) AND a 4h scan (`checkSymbol4h`, `config.strategies.regimeSymbols`) each cycle; the 4h
  scan generates signals via `signalsAt` on 4h candles and routes them to `core_4h` via `paperOpen(sig,"4h")` /
  `paperEvaluate(sym,candles4h,"4h")`. The API returns one card per account; the dashboard pill shows the timeframe.
- **`core_4h` is a MARGINAL edge on a fragile walk-forward (10/22 folds), NOT validated** — it exists to gather
  *forward* evidence, not because it's proven. See `EDGE-REPORT.md`.
- **Do not** silently merge, rename, or drop an account, or repoint its persistence file — that erases the
  experiment / orphans live data. If changing one, keep all records honest and comparable (same fill model).

## Config that matters (`src/config.ts`)

- `watchlist` — symbols scanned each cycle. **Default = `SOLUSDT,BTCUSDT,ETHUSDT`** — the measured-best
  *risk-adjusted* set (override with `WATCHLIST` env). The per-trade short edge generalizes to liquid alts,
  but a direct 3-vs-4-vs-7 portfolio test (all bear-only filtered) is monotonic: every added coin raises
  drawdown (~2× at 7) for **no** extra return, because the shorts are correlated. Narrow is best.
- `strategies.marketRegimeFilter` — **the bear-only filter.** When `true`, the paper engine only opens new
  entries while the broad market is in a (trailing, causal) **downtrend**; it pauses in bull/flat. Gates by
  *market condition*, not trade direction → in practice a short-heavy book. **Cuts drawdown ~½; does NOT
  raise return; it still takes losing trades.**
- `plan.confirmEntryAtClose` — `true` = confirmations fill at the candle close (honest, trustworthy paper
  account). `false` = fills at the level even if price never retested (inflates results ~3× — a mirage).
- `strategies.regimeGate` — per-strategy regime gating (default off; measured to not help).
- `paper.discipline` — the circuit-breaker. **Now ENABLED but SCOPED to `core_4h` only** (`applyTo:["core_4h"]`,
  4 losses / 5% DD / 24h cooldown); the 1h `filtered`/`strategy` accounts are NOT gated (`enabled` still applies
  only to accounts in `applyTo`). Same tested `disciplineBlocks` rails (daily/streak/drawdown), self-resetting
  (daily at UTC midnight; streak/drawdown after `cooldownHours`). **On a fresh trip it fires `src/auditor.ts`
  `triggerAudit()` — the LLM-Auditor STUB** (formats the last 10 closed trades to compact JSON and logs a warning;
  no HTTP yet). Watchdog `checkCircuitBreaker(id)` (paper.ts) runs once/cycle from index.ts to detect the trip;
  the ENTRY gate itself is the existing `disciplineBlocks` check inside `paperOpen`.
  Measured (`npm run disciplineedge`, TWO books): it's a RISK control, not a return lever. On the *unfiltered*
  book (a structural loser) it just shrinks the bleed. On the *filtered* (edge) book the effect is **mixed** —
  the **drawdown rail HURTS** (−29pp: reactive, pauses the recovery), streak/daily are ~neutral (regime already
  handled), and all-rails-combined looks good (+13.6pp) but is **path-dependent/in-sample — unproven**. Default
  OFF is right; if you flip it, avoid the drawdown rail on the edge book and validate OOS. See `EDGE-REPORT.md`.
- `paper.makerEntry` — **opt-in maker/limit-entry forward-test, DEFAULT OFF.** When `enabled`, spins up the
  parallel **`core_4h_maker`** account that rests a LIMIT at each 4h signal's entry and opens only when a later
  candle trades through it (else cancels) — an HONEST fill-gate (no mirage fills), paying maker fee (`feeBps`, ≈2)
  on the entry leg (exit stays taker = conservative). Runs ALONGSIDE market-entry `core_4h` for a clean A/B.
  **Measured (`npm run makeredge`): the maker fee-swap is worth ~+0.009R/signal on the 4h book — the one execution
  win with real evidence** (fees eat ~75% of the thin 4h gross edge; see EDGE-REPORT 2026-07-18). Default OFF = the
  account is absent and nothing changes; run with env `MAKER_ENTRY=on` to start the forward-test. Money-path is unit-tested
  (`limitTouched`) + integration-verified (fill/cancel/fee-leg parity); non-maker accounts are provably unchanged.
- `paper.volFilter` — **opt-in volatility-spike guard, DEFAULT OFF.** Pauses new entries when the just-closed
  candle's range > `spikeMult`×ATR (a news proxy, no external data). **Measured (`npm run bookwalk`): does NOT
  help — on 1h it removes GOOD trades** (spike candles are conviction breakouts, +0.104R in the bear book), so
  keep it off. Kept as a user-flippable comfort/discipline knob only. See `EDGE-REPORT.md` (2026-07-15).
- `paper.newsBlackout` — **opt-in scheduled-window guard, DEFAULT OFF.** Pauses new entries inside recurring
  daily UTC windows + one-off event windows you set (NO live feed — deterministic on purpose). Not backtestable
  here (no event calendar); a discipline knob for sitting out CPI/FOMC, not an edge. See `EDGE-REPORT.md`.
- `paper.*` — start balance, risk %, fees (bps), slippage (bps), max open per symbol, etc.

---

## Dev workflow

- **Run:** `npm start` (or `npm run watch`). No build — `tsx` runs TypeScript directly. Node 18+.
- **Verify before trusting a change:** `npm run typecheck` and `npm test` (unit-test suite; currently 193
  tests — logic, indicators, strategies, OLS, the regime gate, the paper circuit-breaker, the news-proxy
  guards, dashboard HTML integrity). Keep both green.
- **Measurement suite** (all offline, no-lookahead, write `data/*.json`; see README for the full list):
  `audit`, `backtest`, `portfolio`, `alpha`, `regimealpha`, `regimeoverlay`, `regimeoos`, `longedge`,
  `exitedge`, `selectedge`, `bouncedge`, `bounceresolve`, `divedge`, `timeframe`, `universe`, `pairs`,
  `walkforward`, `regimeedge`, `regimegate`, `confirmedge`, `disciplineedge`, `bookwalk` (whole-book OOS
  walk-forward net of fees + vol-spike-filter measurement + built-in FEE SWEEP 5/2/0bps), `makeredge` (honest
  maker/limit-entry vs taker: does the fee saving survive missed fills?), `snipeedge` (closest-structural-level
  TP/SL + trail vs the fixed exit), `sniperbt` (full sniper-reversion-at-major-level strategy, entry+exit
  co-designed), `cvdedge` (does aggressive-taker flow / CVD predict our entries — alignment / trend / divergence buckets),
  `fundingsent` (funding as a contrarian SENTIMENT gauge — full ~3.4yr, paginated), `oiedge` (OI + long/short context —
  ⚠️ Binance serves only ~30 days, so it's forward-test-only, not evidence), `contextreport` (reads the live forward-log
  `data/context-log.jsonl` and buckets each signal's REAL outcome by funding-crowding / flow / long-short — the honest
  forward test for the noise-on-history context signals; `src/context.ts` writes the log + serves the dashboard HUD strip).
  **Run the relevant one before claiming any edge.** 2026-07-18 findings (see `EDGE-REPORT.md`):
  fees eat ~75% of the thin 4h edge (maker entries ~+0.009R help); structure/reversion targeting does NOT clear
  costs (crypto trends through levels, ~30% reversion win); order-book-driven rules are forward-test-only (no
  historical L2 book to backtest).
- **Environment gotchas:** Windows + PowerShell (a Bash tool is also available; each takes its own syntax).
  The multi-agent `Workflow`/`Agent` tools are currently **unusable here** (their subagent model is
  unavailable) — do the work solo. Never touch the user's running paper account/data files from a throwaway
  test (use the scratchpad or pure functions).

---

## Keep this file (and the docs) updated

This is the living onboarding doc. When you **add or change** a strategy, feature, config default, or
produce a new measured finding: update **this file**, plus **`EDGE-REPORT.md`** (the findings) and the
**README** (the run/feature docs). If a future session can't reconstruct "what the bot is and why" from
these three files, they're out of date — fix them.
