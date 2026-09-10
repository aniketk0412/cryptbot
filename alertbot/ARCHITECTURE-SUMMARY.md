# Architecture & Math Summary — for external quant review

*Prepared 2026-07-15 from the source of record (`X:\cryptbot\alertbot`). Every claim below is traceable to a
named file. Read alongside `EDGE-REPORT.md` (measured performance) and `CLAUDE.md` (design constitution).*

> **Read this first — the review questions assume a different bot than this one.**
> The questions we were sent assume a **Python statistical-arbitrage / pairs-trading** system (cointegration
> Z-scores, spread crosses, long-underperformer/short-overperformer, CCXT, Pandas-TA). **This bot is none of
> those.** It is a **TypeScript** (Node/`tsx`, no build step) **single-asset, signal-driven paper-trading bot**
> that trades each symbol **independently**. There is **no pairs trade, no cointegration, no spread, and no
> correlation coefficient anywhere in the trading logic.** The only cross-asset construct is a broad-market
> *regime filter* (details in Q1). Answers below correct each premise and give the real design + formulas.

---

## Q1 — Asset relationship (BTC/ETH/SOL): correlation? cointegration Z-score? lead-lag?

**None of those.** The three symbols are traded **independently**; there is no statistical relationship computed
*between* them for entry. Grep confirms: no cointegration, no Pearson coefficient, no pairs Z-score in any trading
path (`src/*.ts`).

The **only** cross-asset construct is a **broad-market regime filter** (`src/marketregime.ts`), an *opt-in gate*,
not a signal:

- Build an **equal-weight SOL/BTC/ETH price index** rebalanced each bar from closes:
  `idx *= 1 + (1/N)·Σ_i (close_i[k]/close_i[k-1] − 1)` over the last `L` bars.
- Classify its **trailing L-bar return** `trail = idx − 1` (with `L = 168` bars ≈ 7 days @ 1h, band = 3%):
  `trail > +3% → "bull"`, `trail < −3% → "bear"`, else `"flat"` (`classifyRegime`).
- This gates **whether** new entries are allowed on the *filtered* account (it opens only in "bear", the only
  regime with a measured edge); it never sizes or directs a trade. Causal, no lookahead.

Two other things a reviewer might mistake for "correlation logic," both **off by default and not correlation
coefficients**:
- `correlatedCapReached` (`src/paperexit.ts`) — a *position-count* cap: refuse an Nth **same-direction** position
  across the correlated majors. Default `paper.maxSameDirection = 0` (disabled).
- `ols()` (`src/alphacore.ts`) — ordinary least squares, used **only in offline research** (`src/alpha.ts`, to
  estimate the bot's α/β vs a market basket). Not in the live/trading path.

*(For completeness: a genuine SOL/ETH/BTC **stat-arb pairs** strategy was built and measured in `src/pairs.ts` —
it **loses** on all three pairs, −8% to −10%; the majors drift rather than mean-revert. Rejected. See EDGE-REPORT
"Ideas tested and rejected.")*

---

## Q2 — Execution signals: what exact formula triggers an entry?

**Not a spread cross.** Each entry is an **independent per-symbol setup** from one of the enabled detectors in
`src/strategies.ts` (each is a pure `detect(ctx) → signal | null`), plus the founding **support/resistance
touch + confirmation-candle** setup. Three strategy detectors are enabled by default:

**(a) `momentum-TSMOM`** (Moskowitz–Ooi–Pedersen 2012 time-series momentum) — *the only net-positive source over
2 years (see Q6)*. With lookback `lb = 48` bars, threshold `th = 3%`, `a = ATR(14)`:
```
ret = (close[t] − close[t−lb]) / close[t−lb] · 100
LONG  if ret ≥ +3%  AND close[t] > open[t]:
        entry = close[t];  stop = min(low[t], swingLow_20) − 0.3·a;  target = entry + 2·(entry − stop)
SHORT if ret ≤ −3%  AND close[t] < open[t]:  (mirror; stop above swing high)
```

**(b) `breakout-retest`** (trend continuation). Over a prior 25-bar window `[priorLow, priorHigh]`, `height =
priorHigh − priorLow`, tolerance `tol = 0.5·ATR`:
```
LONG  if a recent bar closed above priorHigh, price pulled back to within tol of it,
        and close[t] > priorHigh AND close[t] > open[t]:
        entry = close[t];  stop = priorHigh − 0.3·ATR;  target = priorHigh + height   (mirror for SHORT)
```

**(c) `bollinger-reversion`** (mean reversion, period `p = 20`, mult `k = 2`). `mid = SMA_20`, `sd = STDEV_20`,
`upper = mid + 2·sd`, `lower = mid − 2·sd`:
```
LONG  if low[t] < lower AND close[t] > lower AND close[t] > open[t] AND mid > close[t]:
        entry = close[t];  stop = low[t] − 0.3·ATR;  target = mid   (mirror at the upper band for SHORT)
```

**(d) S/R touch + confirmation** (`src/strategy.ts`/`plan.ts`, the founding feature). Auto-detect a consolidation
range (high/low of last N closed candles, ≤5% wide); on a **touch** of support/resistance + a **rejection
confirmation candle**, build a plan: `support → LONG` (entry at support, stop `= low·(1 − stopBufferPct)`, target
`= range high`); `resistance → SHORT` (mirror). `stopBufferPct = 0.3%`. Confirmations fill at the candle **close**
when `confirmEntryAtClose = true` (honest fill; the level-fill alternative was measured to be a ~3× mirage).

**Entry is directional and single-legged.** No leg is opened against another asset. A confluence engine
(`src/orderflow.ts`, `src/evidence.ts`) grades each setup STRONG/OK/WEAK from ~8 factors (order flow, FVG, sweep,
book wall, HTF bias, premium/discount, structure); **grades gate notifications, not paper entries.**

---

## Q3 — Timeframes & data source

- **Timeframe:** **1-hour** by default (`config.interval = "1h"`, override via `INTERVAL` env). All strategies,
  the regime basket, and the backtests run on this. (Higher TFs were tested — see EDGE-REPORT — and are not more
  profitable net of fees.)
- **Data transport is HYBRID:**
  - **REST polling** for everything analytical — candles (`GET fapi/v1/klines`), order book depth
    (`fapi/v1/depth`), open interest, funding/premium index (`fapi/v1/premiumIndex`), long/short ratio. See
    `src/binance.ts`. The main loop polls each cycle.
  - **One WebSocket** for live last-trade price only: `wss://stream.binance.com:9443` — the **SPOT** combined
    `miniTicker` stream (`src/liveprice.ts`). *Note:* the **futures** stream (`fstream`) opens but delivers **zero
    frames on our network**, so live price is sourced from spot; this is a documented environment quirk, not a
    design choice. The liquidation feed (also futures WS) is therefore inactive here.
- No tick data; candles are 1m+ granularity. History for backtests is paged backward via `klines` `endTime`
  (`fetchDeepHistory`), reaching ~2 years for the majors.

---

## Q4 — Risk management: sizing, stops, targets; shared or per-asset?

**Managed per-trade and per-account, NOT as a pooled 3-asset portfolio budget.** Formulas in `src/plan.ts`:

- **Position size (fixed-fractional):**
  `riskUsd = accountUsd · riskPct/100` (defaults `accountUsd = $1000`, `riskPct = 1% ⇒ $10/trade`);
  `sizeUnits = riskUsd / |entry − stop|`; `notional = sizeUnits · entry`; `leverage = notional / accountUsd`.
  Each trade risks a fixed % of the **account's own current (compounding) balance**.
- **Stop-loss:** structural, set by the detector (swing/level ± `0.3·ATR`, or level `± stopBufferPct 0.3%`), not a
  fixed %. `|entry − stop|` is the 1R unit everything else is expressed in.
- **Take-profit:** detector-specific `target` (e.g. TSMOM `= entry ± 2R`; bollinger `= mid`; S/R `= opposite level`).
  Display plans also carry `tp1/tp2/tp3 = entry ± {1,2,3}·R` or nearest structural pivots (`applyStructureTps`).
  A gate `minRR` (1.5 for plans / 1.0 for reclaim setups) rejects low reward:risk setups.
- **Exit management (`src/paperexit.ts`, opt-in):** partial-TP ON by default (bank `fraction = 0.5` at `+1R`,
  move stop to break-even); move to break-even at `+2.5R`; taker fee `5 bps/side`; stop slippage modeled.
- **Cross-asset coupling:** essentially none. Sizing is independent per symbol; `maxOpenPerSymbol = 1`. The only
  optional coupling is the same-direction position **count** cap (`maxSameDirection`, default **off**). There is
  **no shared VaR / portfolio heat / correlation-adjusted sizing.**
- **Two parallel paper accounts** run off the same signal stream, each with its **own** compounding balance and
  persistence: `filtered` (regime-gated) and `strategy` (unfiltered). This is a live A/B of the regime filter.

---

## Q5 — Exchange & tech stack

- **Language/runtime:** **TypeScript on Node** via `tsx` (no build step). **Not Python.**
- **Libraries:** **none of CCXT / Pandas-TA / TA-Lib.** HTTP is the Node **native `fetch`**; all indicators
  (EMA, RSI-Wilder, ATR, VWAP, SMA, STDEV, Bollinger, pivots, CVD) are **hand-rolled** in `src/indicators.ts`.
  Dashboard is a React-Native-Web / Expo app; server is a no-dependency Node `http` server. Optional Telegram
  notifications via REST.
- **Exchange/API:** **Binance USDⓈ-M Futures** REST (`fapi.binance.com` — klines, depth, OI, funding) for all
  analysis; **Binance SPOT** WebSocket for live price (per Q3). **No authenticated trading key is used and no
  live order path is wired** — the bot is **paper-only**; a live-execution module exists as a *safety-railed
  spec/shadow* (double-gated behind `config` + `LIVE_TRADING` env) with **no order-placing code active**.

---

## Q6 — Measured performance (a reviewer will ask, so stated up front)

On the **2-year deep backtest** (`npm run deepbacktest`; SOL/BTC/ETH @ 1h; 6,366 trades; 2024-06 → 2026-07; net of
5 bps taker): the full book is **net-negative, −0.106R/trade** (win 32%); the gross edge is **+0.009R** — real but
**thinner than fees**, which run ~0.11R/trade. A compounded $1000 @1% risk would have gone to **~$0**. Positive in
**0 of 8** time-folds; still negative out-of-sample. **The one fee-clearing component is `momentum-TSMOM`
(+0.044R, 45% win — wider stops ⇒ low fee-per-R); `bollinger-reversion` is the biggest drag (−0.182R).** Full
detail and every other cut (per-symbol, side, regime, OOS, fee sweep) are in `EDGE-REPORT.md` (2026-07-15 two-year
addendum) and `data/deepbacktest.json`. **Honest status: a rigorously-measured paper/research tool with no
validated net-positive edge as configured — not a live money-maker.**

---

## Q2b — Exit & stop-loss ladder (the precise per-candle logic)

Managed in `paperEvaluate` (`src/paper.ts`) + pure helpers in `src/paperexit.ts`. For each open position, walk
every newly-closed candle in order:

```
riskDist = |entry − stop|        # the 1R unit, fixed at entry
peak     = favourable extreme so far (max high if LONG / min low if SHORT)

1. HARD EXIT — resolveExit(long, stop, target, low, high, slip):
     STOP is checked BEFORE target (conservative; a candle spanning both resolves as a stop):
       LONG : if low  ≤ stop   → exit = stop·(1 − slip)   reason "stop"   (market fill, slippage applied)
              elif high ≥ target → exit = target            reason "target" (limit fill, no slippage)
       SHORT: mirror (high ≥ stop → stop·(1+slip); low ≤ target → target)
     if hit → close, bank P&L net of taker fee both legs, DONE.

2. else update peak; favR = (peak − entry)/riskDist   (how many R in our favour we've reached)
   a. PARTIAL TP (opt-in, ON): if favR ≥ 1R and not yet done and source not excluded →
        close fraction=0.5 at +1R, bank it, move stop to a FEE-AWARE break-even (beStop), beDone=true
   b. BREAK-EVEN: if favR ≥ 2.5R and not beDone → move stop to entry ± (2·feeBps) buffer, beDone=true
   c. ATR TRAIL: if beDone and trailAtrMult>0 → stop = peak ∓ trailAtrMult·ATR   (ratchets one way only)
```

Fees/slippage: taker `feeBps = 5` per side; stop `slippageBps` applied to stop fills only (targets are limits).
Funding, liquidation and partial-fill probability are **not** modelled. Exit reasons: `target | stop | manual`.
*(Measurement note: on the earning cohort the plain fixed stop/target is already best; partial-TP/BE/trail are
smoothness levers, not return levers — see EDGE-REPORT `exitedge`.)*

## Q3 — Order generation & execution path (honest: nothing is sent to an exchange)

**There is no live order execution in this codebase.** A grep for signed order submission (`fapi/v1/order`, HMAC
signing, `X-MBX-APIKEY`) returns nothing. Two paths exist:

**(a) Paper engine — the real, active path (simulation, no network).** `paperOpen` books a position onto an
account's in-memory compounding balance; `paperEvaluate`/`closePosition` bank the simulated P&L. Pseudocode:
```
# ENTRY (paperOpen, per closed candle / signal)
sig = firstNonNull(detect() across enabled strategies)  or  S/R touch+confirmation plan
risk = |sig.entry − sig.stop|;  if risk ≤ 0 or reward/risk < minRR: skip
if volFilter.enabled and volSpike(symbol): skip          # opt-in, default OFF
if inNewsBlackout(now): skip                             # opt-in, default OFF
for acc in [filtered, strategy]:
    if acc.applyFilter and marketRegimeBlocks(regime): continue   # 'filtered' opens only in bear
    if correlatedCapReached(acc.open, dir, cap): continue         # default OFF (cap 0)
    size = acc.balance · riskPct/100 / risk                        # fixed-fractional off THIS account's balance
    acc.open.push({entry, stop, target, sizeUnits: size, source, direction})
# EXIT: the Q2b ladder → closePosition() adds P&L (net fees) to acc.balance
```

**(b) Live "shadow" — a dry-run intent generator that PLACES NOTHING (`src/live.ts`, Stage 1).** Double-gated
(`config.live.enabled = false` **and** env `LIVE_TRADING = on`). When on, it mirrors the `filtered` paper account
and, for each mirrored position, builds the order it *would* submit and logs it — the closest thing to
"order generation" that exists:
```
toOrder(p):                                   # p = a mirrored paper position
   qty   = roundDownToLotStep(p.sizeUnits, stepSize)      # from PUBLIC exchangeInfo
   entry = roundToTick(p.entry, tickSize)
   type  = confirmEntryAtClose ? "MARKET" : "LIMIT"
   return {side: LONG?BUY:SELL, type, qty, entry, stop, target, notionalUsd, exposureX}
blocked = entryDecision(halted, openCount, notionalUsd, caps)   # rails: max-concurrent, notional cap, daily/DD/streak halts
log("WOULD " + type + " " + side + " ... SL ... TP ... — PLACES NOTHING")   # no submission branch exists
```
The only network call in `live.ts` is the **public, read-only** `exchangeInfo` (for faithful tick/step rounding).
Going live would be a deliberate future stage (`LIVE-TRADING-SPEC.md`), not a config flip. **A reviewer should
treat this as a strategy-and-risk system, not an execution system — the execution layer is intentionally unbuilt.**

## Q4 — Honest limitations (latency, rate limits, regime shifts)

- **Latency / data transport.** The loop is **REST-poll driven**, not event-driven off exchange candle-close, and
  live price comes from a **single SPOT WebSocket** because the Binance **futures** stream delivers zero frames on
  this network (so the liquidation feed is inactive here). For a **1h** strategy this is not the binding
  constraint, but the design is **not latency-competitive** and would be inadequate for any low-timeframe or live
  execution use. (The dashboard was optimised from 11→3 requests + gzip; that's UI latency, not signal latency.)
- **API rate limits.** Only a per-request `AbortSignal.timeout(10s)` guards calls. There is **no request-weight
  accounting, no exponential backoff, no rate limiter.** Fine at the current tiny volume (3–4 symbols, hourly),
  but it **would need a proper limiter/backoff before scaling symbols or going live.**
- **Market-regime shifts.** The regime signal is a **168-bar (~7-day) trailing** basket return — it **lags turns
  by design** (days, not minutes). Over the 2-year test the bear gate **reduced trade count but not per-trade loss
  rate** — it is a **risk reducer, not an alpha source.** There is no fast/adaptive regime model and **no
  volatility-scaled position sizing**; size is a flat % of balance regardless of regime or vol.
- **Edge / economics (the real limitation).** Gross edge **+0.009R < ~0.11R fee drag ⇒ net −0.106R/trade** over
  6,366 trades; **no validated net-positive edge**, and a compounded account trends to zero. This is a
  cost-structure problem at 1h taker fees, not a data-plumbing bug.
- **Backtest realism.** Fills are assumed at the signal price / first-touch; **funding, liquidation, order-book
  slippage, and partial-fill probability are not modelled**; depth is a live snapshot, not streamed history;
  gold (XAUT) has < ~4 months of history. Treat backtest R as a **mildly optimistic upper bound.**
- **No circuit-breaker on the paper accounts by default** (the `discipline` rails are opt-in, default OFF); the
  paper accounts trade straight through streaks/drawdowns. The live *shadow* runs the halts, the paper book does
  not (by design, so the unfiltered experiment stays pure).

---

### File map for the reviewer
`src/strategies.ts` (detectors) · `src/plan.ts` (sizing/stops/targets) · `src/marketregime.ts` (regime basket) ·
`src/paper.ts` + `src/paperexit.ts` (paper engine, exits, gates) · `src/binance.ts` + `src/liveprice.ts` (data) ·
`src/indicators.ts` (math) · `src/deepbacktest.ts` / `src/bookwalk.ts` (backtests) · `EDGE-REPORT.md` (findings).
