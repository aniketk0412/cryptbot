# Edge Report — what the data actually says about this bot

*A living summary of the measured edge, so decisions rest on evidence, not vibes. Regenerate the
numbers anytime with the tools in the "Measurement suite" (README). All backtests are no-lookahead,
SOL/BTC/ETH @ 1h — ~1500 candles (~2 months) for the single-window tools, ~312 days of deep history for
the regime/alpha analysis; in-sample unless a section says otherwise (the bear-only filter is checked
out-of-sample) — treat as directional, re-validate as the live track record grows.*

Last measured: 2026-07-09 · **addendum 2026-07-11** (exit management + multi-timeframe, below) · **2-year deep backtest 2026-07-15** (see top addendum).

---

## Addendum — 2026-07-18 · execution + structure sweep (`bookwalk` fee-sweep, `makeredge`, `snipeedge`, `sniperbt`) — where the leverage is, and isn't

Session goal: "improve the bot." Attacked the two levers a 50%-win / −0.070R-live book leaves open — **execution/fees**
and **structure-based entries/exits** — with four measured tests (crypto majors, net of fees, OOS folds). New tools:
`npm run makeredge`, `npm run snipeedge`, `npm run sniperbt` (plus `bookwalk`'s built-in fee sweep).

1. **FEE SWEEP (`bookwalk`, FEE_BPS 5/2/0):** confirms *where* an edge exists. **1h has no gross edge** (even at 0 fees
   only +0.022R, 3/8 folds — noise). **4h has a thin gross edge (+0.067R) that taker fees eat ~75% of** → net +0.017R.
   Cutting fees toward maker (2bps) roughly TRIPLES the 4h net (+0.017→+0.046R). Fee/execution is the highest-leverage lever.

2. **MAKER/LIMIT ENTRIES (`makeredge`, honest fill-gating):** the **defensible** benefit is the pure fee-swap ≈ **+0.009R/signal**
   on 4h (pay maker not taker on the same fills). A larger +0.047R appears only under optimistic limit-fill-timing
   assumptions I can't validate without tick data; the "realistic" feasibility filter returned ~100% (entries are defined
   at/inside the close), so it added no real conservatism — trust the fee-swap floor, not the optimistic figure. Momentum
   (81% of signals) gains only the fee-swap; the big jump lives in breakout-retest and is a timing artifact. NB `makeredge`
   counts overlapping same-source signals, so its ABSOLUTE R isn't comparable to position-gated `bookwalk` — the LIFT is the takeaway.

3. **CLOSEST-LEVEL TARGETS (`snipeedge`) — user hypothesis "aim at the nearest level, targets are too far":** tested on the
   EXISTING entries, closest-level targeting **HURT badly** — baseline −0.005R → nearest-level **−0.390R** (win 39%→36%, **0/8
   folds**). Reason: a close target paired with a far *structural* stop (momentum entries sit mid-trend, far from protection)
   collapses R:R (~risk 1R to make 0.3R); a 36% hit-rate needs ~77% to pay. **The one exception: short-at-resistance
   (the bot's selective S/R-confirmation entries) + trail = +0.249R (win 31→40%, n=115)** — closest-level+trail only pays on
   *reversion-at-a-level* entries (tight stop → good R:R), not on chases. **Trailing helped every variant** (the robust exit idea).

4. **SNIPER REVERSION (`sniperbt`) — user hypothesis "sniper entry at the level, not mid-move":** built the full co-designed
   setup (fade a rejection of a MAJOR level, tight stop just beyond it, target nearest opposing level, trail). **Net-NEGATIVE:**
   fixed −0.270R, **+trail −0.117R, win only 30%, 2/8 folds** (train −0.103 → test −0.149, so reliably losing, not overfit).
   avg R:R was a healthy 2.63 — the killer is the **30% win rate: crypto majors trend THROUGH levels more than they revert.**
   Generalizing the n=115 flicker from #3 to "any major-level poke" (2431 setups) diluted it into noise — the *selectivity* was
   the edge, not the level-fade. Only ETH was positive (+0.135R); BTC/SOL negative.

5. **CVD / aggressive-taker flow (`cvdedge`) — "monitor more signals" test #1:** does order-flow predict our entries' outcomes?
   Bucketed the SAME entries by a causal CVD feature (net of fees, 6857 entries, 4h). **Blanket flow alignment is NOISE**
   — aligned +0.022R vs contra +0.016R (gap +0.006R), matching `selectedge`/`chainedge`. Two FAINT threads: the trailing
   14-bar CVD-*trend* alignment separates +0.029R (5/8 folds) from +0.004R (3/8), and flow-alignment helps specifically on
   S/R-reversion entries (resistance aligned +0.054 vs contra −0.027) — the same reversion pocket. The flashy "divergence
   +0.097R" is a TRAP (only 3/8 folds → outlier-driven). And on the dominant momentum book flow-CONTRA beat aligned
   (+0.040 vs +0.027), so a blanket CVD filter would HURT momentum. **No usable standalone CVD edge** — it's discretionary
   context at best, not an auto-filter.

6. **Funding-as-SENTIMENT (`fundingsent`) — the regime-artifact lesson (important).** Thesis: extreme +funding = crowded
   longs = squeeze-down risk → fading the crowd (short into extreme+funding) should pay. On a **166-day window it looked
   spectacular** — AGAINST-crowd **+0.430R** vs WITH-crowd −0.126R, and it even survived per-symbol/outlier/holdout cuts.
   **But it was a REGIME ARTIFACT.** Paginating funding back to the **full ~3.4yr multi-regime history** (the endpoint
   serves ~500 rows/page, so you must walk `endTime` back) collapsed it to **NOISE: against +0.041R vs with +0.045R (gap
   −0.004R)**; the short-side effect fell +0.627R→+0.076R and SOL went negative. Lesson banked: **a short window LIES** —
   always extend to multiple regimes before believing a positive. Funding-as-sentiment: no usable edge.

7. **OI + Long/Short (`oiedge`) — can't be validated here.** Binance's public `openInterestHist` / `globalLongShortAccountRatio`
   only serve the **last ~30 days**. Over that one-regime window the OI/price interaction (↑price+↑OI "trust" vs ↑price+↓OI
   "fade") is **inconsistent across symbols** (↑price↑OI fwd-return SOL +0.31% / BTC +0.21% / ETH −0.05%) and L/S extremes
   don't cohere (crowded-long fwd SOL +1.65% but BTC/ETH negative), n≈35–50/bucket. Given the funding lesson, a 30-day
   sample cannot validate anything regardless. **OI/LS are forward-test-only** — the honest way to test them is to LOG
   them at each entry (context HUD) and measure over months, not to trust a 30-day backtest.

**Bottom line on "monitor more signals":** every backtestable Tier-1 positioning/flow signal (CVD, funding-sentiment) is
NOISE net of fees; OI/LS can't be backtested at all. They are **discretionary context + forward-measurement candidates**,
not auto-edges. This is consistent with the whole report: no signal-combination lever has produced a robust net edge.

**Verdict:** the backtestable core of the structure/sniper/reversion vision does **not** clear costs — crypto majors trend, so
fading levels loses. The lever with real (if modest) evidence is **execution/fees on 4h** (maker entries ~+0.009R). The part of
the vision that might rescue reversion — **order-book confirmation (only fade a level with a real wall defending it)** — is exactly
what **cannot be backtested**: the free Binance pipeline has no historical L2 book, so it is **forward-test-only**. Trailing exits
remain the one robust improvement. Nothing here changes the standing conclusion: **no validated net-positive edge.**

## Addendum — 2026-07-17 · R:R / EXIT sweep on the 4h book (`npm run rrsweep`) — trailing beats fixed (marginally)

Swept the exit target on the 4h book (SOL/BTC/ETH, ~4yr, 1011 signals, net 5bps): fixed R:R multiples 1–4R and a
trailing k×ATR. **Every FIXED target is net-negative over 4yr** (1R −0.052, 1.5R −0.049, **2R −0.021 (least-bad,
the current default)**, 2.5R −0.025, 3R −0.040, 4R −0.028; win% falls 49→31% as targets widen). **The ONLY
net-positive exit is a trailing 3×ATR stop: +0.016R in-sample, +0.051R OOS held-out** (trail-2ATR −0.016R). So on
the momentum-dominant 4h book, LETTING WINNERS RUN (trail) beats capping at a target — the opposite of the old 1h
bear-short/S-R book where `exitedge` found fixed wins. CAVEATS: (1) it's the best of 8 swept variants = selection
bias; (2) magnitudes are tiny (+0.016R); (3) over the full 4yr window even the base is negative — the earlier 4h
+0.079R was on a rosier 2yr slice (recency). **Actionable but unproven: a trailing-3ATR exit is worth forward-testing
on core_4h, but I did NOT flip `config.paper.exit.trailAtrMult` (it's global → would change the 1h accounts too, and
this is in-sample-selected). Owner's call.**

**WALK-FORWARD FOLLOW-UP (`RR_DAYS=2200 npm run rrsweep`, 35 rolling 60d windows over ~5.8yr, 1459 signals): the
trailing lead is REAL, not in-sample luck.** Trailing-3ATR pooled OOS **+0.041R, 18/35 positive folds (51%)** vs
2R-fixed **+0.006R, 15/35 (43%)** — trailing beats fixed across shifting windows, so "let the momentum winner run"
is a genuine, measured exit improvement on the 4h book (over the full window most exits turn net-positive in-sample,
another sign of window-sensitivity). **Still MARGINAL** (neither exit clears 60% of folds — the underlying 4h edge
remains fragile), but this is the strongest exit-improvement evidence in the whole effort. Strengthens the case to
run `trailAtrMult≈3` on core_4h specifically (not the global config) when the owner decides.

**PER-SYMBOL FOLLOW-UP (`RR_SYMBOLS=<sym> RR_DAYS=2200 npm run rrsweep`, trailing-3ATR, 4h WF): the 4h edge is
CONCENTRATED, not spread.** BTC pooled OOS **+0.118R (18/35 folds, 51%)** — strongest; SOL +0.073R (14/33, 42%) —
marginal+; **ETH −0.066R (13/35, 37%) — FAILS, a net drag.** So the aggregate "+0.041R" 4h book is BTC/SOL earning
while ETH bleeds — a BTC/SOL-only 4h book would likely be less marginal. CAVEAT: this is **post-hoc symbol
selection** on a fragile edge (picking BTC because it backtested best is exactly the overfit trap), smaller
per-symbol n, and even BTC is only 51% of folds. Treat as a hypothesis to forward-test on core_4h, NOT a rule —
did not change the live watchlist.

**BTC/SOL-ONLY vs +ETH (`RR_SYMBOLS=SOLUSDT,BTCUSDT RR_DAYS=2200 npm run rrsweep`, trailing-3ATR):** dropping the
ETH drag roughly DOUBLES the marginal edge — pooled OOS **+0.091R (19/35 folds, 54%)** vs the 3-symbol book's
+0.041R (18/35, 51%); net +0.091R vs +0.045R. So a BTC/SOL 4h book is measurably better. **But the caveat is
decisive: ETH was dropped BECAUSE it backtested worst = textbook post-hoc selection**, so forward performance will
be lower than +0.091R, and even this "improved" book is still MARGINAL (54% of folds — fails ~half the 2-month
windows). Legitimate to forward-test core_4h on BTC/SOL, NOT proof; live watchlist unchanged. Bottom line stands:
the strongest configuration found (BTC/SOL 4h, trailing-3ATR) is a marginal, selection-inflated, still-fragile edge
— not a validated money-maker.

## Addendum — 2026-07-17 · CONFLUENCE-CHAIN test (`npm run chainedge`) — stacking factors does NOT lift win rate

Tested the "combine S/R + supply-demand zone + trend + order-flow + momentum into a high-probability chain" idea:
score each signal by how many of 5 factors AGREE with its direction, bucket win%/net-R by chain length, across
4h/12h/1d. **Result: win rate is FLAT (~33–40%) regardless of chain length.** On 4h (n=2407, the only trustworthy
sample) win% by chain 0→5 is 44/33/36/33/28% — it does NOT rise. The high-chain (≥4) buckets that look good on
12h/1d (57%/33% win, big +R) are **n=6–7 — noise, not signal.** Root cause: the factors partly CONTRADICT (momentum
wants breakout/premium, mean-reversion wants discount/zone), so a clean 4–5 stack is rare and no more predictive.
**Verdict: naive multi-factor confluence stacking is not a high-probability selector here** — consistent with the
earlier `audit`/`selectedge` findings that only order-flow carried real factor lift, and it was redundant with the
regime filter. Win rate ~35% is structural; the edge (where any) comes from R:R, not hit-rate.

## Addendum — 2026-07-15 · MULTI-TIMEFRAME SWEEP (`npm run deepbacktest`, config.backtest.timeframes) — a real lead at 4h

`deepbacktest` now sweeps `config.backtest.timeframes` (default 1h/4h/12h) sequentially, all trimmed to the **same
~720-day window** (apples-to-apples), with a side-by-side table incl. the 70/30 OOS split. Strategy detectors run
on native bars (bar-count strategies → that IS the TF test); only the wall-clock regime lookback scales per TF.

**Sweep (unfiltered book, net 5bps, same window):**

| TF | Trades | Win% | Gross | **Net** | Train 70% | **Test·OOS 30%** | Folds+ |
|---|---|---|---|---|---|---|---|
| 1h | 1152 | 44% | +0.037R | +0.010R | +0.043R | **−0.067R** | (overfit) |
| **4h** | **521** | **42%** | **+0.103R** | **+0.079R** | **+0.099R** | **+0.032R ✅** | **7/8** |
| 12h | 228 | 37% | −0.034R | −0.053R | −0.060R | −0.039R | (negative) |

**4h is the first configuration in this entire investigation that is net-positive in-sample AND holds out-of-sample
AND is fold-stable** (7/8 positive folds; the 1h book was 0/8 pre-refactor). Compounded +44% ($1440), maxDD 21%.
The architect's hypothesis is **validated**: higher TF ⇒ wider %-stops ⇒ lower fee-per-R. It rescues **breakout-retest**
too (fee-per-R 0.16R@1h → 0.036R@4h; net −0.073R@1h → **+0.099R@4h**), and **momentum-TSMOM** stays strong
(+0.094R, win 48%). 1h still overfits; 12h has too few trades (n=228) and no signal.

**IMPORTANT nuance — the regime gate HURTS at 4h.** At 4h the per-regime edge is BEAR +0.153R > flat +0.056R >
bull +0.015R — so the current `allowedRegimes = ["bull","flat"]` gate *excludes the best 4h regime*. Result: the
FILTERED book at 4h is +0.033R, **3/8 folds, OOS −0.116R (fails)**, while UNFILTERED is +0.079R/7/8/OOS +0.032R.
**At 4h the best config is NO regime gate.** (The regime→performance mapping flips by timeframe — more evidence
that regime gating is fit-to-sample, not structural.)

**HONEST CAVEATS (do not over-claim):** (1) one 2-year window + one 70/30 split — the held-out +0.032R is **thin**
and **dropped from +0.066 to +0.032 when the date-window confound was fixed** (window-sensitive). (2) Picking the
best of 3 timeframes is a mild selection effect. (3) n=521 is moderate. **Verdict: the strongest, most promising
lead found — a genuine candidate edge — but it needs FORWARD validation (walk-forward / live paper on 4h), not just
this single in-sample+OOS pass, before it's trusted or sized. `config.interval` was NOT flipped to 4h (founding
change — left for an explicit decision).** Detail: `data/deepbacktest.json`.

**WALK-FORWARD FOLLOW-UP (2026-07-15, `DEEP_WFA=4h DEEP_DAYS=1460` — 22 rolling 180d-train/60d-test windows over
4 years, 2023–2026): the 4h edge does NOT robustly survive.** Pooled OOS **+0.042R** (win 40%, n=919) but **positive
in only 10/22 folds (45%)** — folds swing +0.42R … −0.53R with no stability; over the full 4-year window the book is
+0.033R (vs +0.079R on the cherry 2-year window — the single-split result was partly recency). **Verdict: MARGINAL —
pooled-positive but fragile; NOT a validated, stable edge; do not size up, do not pivot the founding architecture on
it.** This is the honest ceiling of the whole investigation: the bot's best configuration is a *marginal, fragile,
possibly-real* 4h momentum book — better than the 1h book (which is net-negative/overfit), but not a proven money-maker.
`npm run deepbacktest` gains a walk-forward mode (`DEEP_WFA=<tf>`, `WFA_TRAIN_DAYS`/`WFA_TEST_DAYS`).

---

## Addendum — 2026-07-15 · FEE-DRAG REFACTOR (drop bollinger + fee-to-risk filter) — measured

Acting on the 2-year finding below, three changes shipped (all tunable): **(1) `bollinger-reversion` DISABLED**
(config.strategies.bollinger=false — it was the biggest drag, −0.182R, gross-negative); **(2) a fee-to-risk filter**
(`config.plan.feeFilter`, default ON; `paperexit.feeBlocksTrade`) that rejects a signal when round-trip taker fee
> `maxFeeThresholdPct` (5%) of the 1R stop — pruning churny tight-stop trades; **(3) opt-in ER regime + efficiency
sizing** (default OFF — risk-control, not measured to add edge).

**Measured effect (`npm run deepbacktest`, same 2-year window, net 5bps) — it WORKED mechanically but is NOT a
validated edge:**
- The fee filter **skipped 5,215 of 6,366 trades (82%)** — the churny tail. Remaining n=1,189.
- Unfiltered book: **−0.106R → +0.013R net** (win 32%→44%); **fee drag 0.115R → 0.027R** (~4× lower — the fix
  did exactly what it was designed to). Compounded $1000@1%: **−100% (blown) → +9%** (maxDD 36%). `momentum-TSMOM`
  carries it: +0.049R net, n=954.
- **BUT it FAILS out-of-sample: train +0.041R → held-out test −0.051R; positive in only 3/8 folds.** The thin
  in-sample edge does not survive on unseen data — same overfit signature as the earlier higher-TF mirage.
  **Verdict: a real, measured improvement (cut the drag, flipped in-sample positive), NOT a validated live edge.**
- **NEW finding — the bear-only regime filter now HURTS.** With a momentum-dominant book the edge is in BULL
  (+0.059R) and FLAT (+0.067R), and **BEAR is the worst regime (−0.066R)** — the opposite of the old S/R+reversion
  book. So `filtered` (bear-gated) is now −0.066R while `strategy` (unfiltered) is +0.013R.

**FOLLOW-UP (2026-07-15) — regime gate flipped to `config.market.allowedRegimes = ["bull","flat"]`** (new config
namespace; `marketRegimeBlocks` now blocks any regime not in the list; boot/cycle logs + dashboards updated so bull
no longer falsely reports a pause). Measured (deepbacktest, same 2yr): the **filtered bull/flat book is the
best-LOOKING book yet — NET +0.063R, win 48%, compounded +52% ($1521), maxDD 23%** (vs unfiltered +0.013R/+9%/36%DD
and old bear-only −0.066R/−28%). **BUT it STILL fails out-of-sample: train +0.113R → held-out test −0.055R, 3/8
folds.** This is exactly the overfit risk called out when the change was requested: selecting the regimes that
happened to win in THIS 2-year sample lifts the in-sample fit but not the held-out period. **Verdict: a legitimate,
now-default config to FORWARD-test — not a validated edge. Do not read the +52% as "profitable"; the held-out
period still loses.** `["bull","flat","bear"]` = gate off; `["bear"]` = old rule. Detail: `data/deepbacktest.json`.

---

## Addendum — 2026-07-15 · TWO-YEAR deep backtest (`npm run deepbacktest`) — the definitive sample

The biggest, most authoritative test to date: **6,366 trades over 747 days** (2024-06-28 → 2026-07-15),
SOL/BTC/ETH @ 1h, full signal book (enabled strategies + S/R confirmations), first-touch fixed exit, causal
bear-basket regime, **net of 5bps taker**. This supersedes the earlier short-window numbers.

**Headline (net of fees):** STRATEGY (unfiltered) **−0.106R/trade**, win 32%, totalR −674. FILTERED (bear-only)
**−0.092R/trade**, win 32%, totalR −181. **Gross is razor-thin positive (+0.009R / +0.007R) — fees (~0.10–0.12R
per trade) erase the entire edge.**

**Compounded ($1000, 1% risk/trade, sequential approx):** STRATEGY → **$0 (−100%, account blown, maxDD 100%)**;
FILTERED → **$126 (−87%, maxDD 89%)**. A 2-year live run of this book would have wiped the account.

**Per-strategy — the one real signal in the whole book:**
| Source | n | gross | fee drag | NET | win | note |
|---|---|---|---|---|---|---|
| **momentum-TSMOM** | 1039 | +0.073R | 0.029R | **+0.044R** | 45% | **ONLY net-positive source** — wide stops → low fee-per-R |
| breakout-retest | 1472 | +0.087R | 0.160R | −0.073R | 24% | good gross, but tight stops → fees eat it |
| support (S/R long) | 838 | +0.012R | 0.107R | −0.095R | 29% | |
| resistance (S/R short) | 959 | −0.053R | 0.113R | −0.166R | 27% | |
| **bollinger-reversion** | 2058 | −0.051R | 0.131R | **−0.182R** | 35% | **biggest drag** — confirms `assetchar`: fade is sub-fee |

**Other cuts:** per-symbol all net-negative (BTC worst −0.165R, ETH −0.065R, SOL −0.082R). LONG −0.122R vs SHORT
−0.090R (shorts less bad, both negative). Regime: bull −0.132R / flat −0.092R / bear −0.092R (over 2yr the bear
gate no longer separates as cleanly as the shorter windows suggested). **Time folds: STRATEGY positive in 0/8;
FILTERED 3/8. OOS (70/30): STRATEGY train −0.097 → test −0.127; FILTERED train −0.119 → test −0.029 (both still
negative).** Fee sweep: at **0 bps** both books turn barely positive (+0.009 / +0.007R) — proof the problem IS fees,
not signal absence; at maker 2 bps still negative (−0.037 / −0.033R).

**VERDICT (2-year, n=6366): NO net-positive edge. Neither book clears fees; the unfiltered book blows the account.**
The gross signal is real but too thin to pay 1h taker costs. **The single constructive thread: `momentum-TSMOM`
is the only fee-clearing source (+0.044R, 45% win, low fee-per-R from wider stops)** — everything else, especially
`bollinger-reversion`, is a net drag. Obvious next experiment: isolate TSMOM (drop bollinger + the tight-stop
sources), validate it OOS on its own, and check if a TSMOM-only book on higher TF / maker fills is net-positive.
Detail: `data/deepbacktest.json`.

---

## Addendum — 2026-07-11 · exit management & multi-timeframe

Newer work, same discipline (in-sample → OOS → portfolio before trusting anything):

- **Partial take-profit** (`config.paper.exit.partialTp`, now **ON**): bank half at +1R → break-even on the rest.
  Measured (`npm run exitedge`, 2559 trades): lifts win-rate **33% → 50%** and rescues the **38% of +1R winners
  that round-tripped to ≤0** — but it does **not** raise total return (~−0.01R/trade). A giveback/smoothness tool,
  not a profit one.
- **Structural TP levels** (shipped, display-only): each setup's TP1/TP2/TP3 are now the nearest / next / next
  swing **resistances** (long) or **supports** (short), so you can scalp to real levels. The paper engine still
  auto-exits at its measured single target.
- **Structural TRAIL exit — REJECTED.** In-sample it beat the fixed target (+0.232R vs +0.155R on bear-shorts),
  but the OOS split killed it: recent half **−0.076R** (fixed +0.405 > trail +0.329). Period-dependent → **not
  wired**; the fixed target stays. (`npm run scalpedge`.)
- **Multi-timeframe display** (shipped): a 15m / 1h / 4h / 1d trend strip per symbol (zoom in / out).
- **MTF-alignment gate** (`config.strategies.mtfAlignFilter`, opt-in, **default off**): take a short only when the
  4h **and** 1d also point down. The per-trade lift is real and **holds OOS** (aligned shorts +0.307R vs +0.101R
  all-shorts in the recent half). BUT the **portfolio test** (`npm run mtfedge`) shows it's a **risk-reducer, not a
  return-booster**: short book ALL +124% / **65% DD** vs ALIGNED +75% / **41% DD**, ret/DD ~flat (1.91 vs 1.83).
  So — exactly like the bear filter — it **cuts drawdown (~37%) at a return cost**; enable only if you want lower DD.

**Through-line, reinforced:** per-trade edges keep failing to become *risk-adjusted portfolio* wins (partial-TP,
trail, and the MTF gate were all measured — none is a free return lever). The levers that survive are **risk
control** (bear filter, MTF gate → less drawdown) and **smoothness** (partial-TP → higher win-rate). There is still
**no validated return/growth lever** — the honest bottom line above stands. New tools: `npm run exitedge · scalpedge · mtfedge`.

---

## Addendum — 2026-07-13 · paper circuit-breaker (`config.paper.discipline`, opt-in, default OFF)

The paper engine took every qualifying signal and traded straight THROUGH losing streaks and drawdowns, while
the live shadow HALTS on daily-loss / consecutive-loss / drawdown rails — so the paper record slightly
overstated tail resilience vs an account we'd actually run. Added an **opt-in `paper.discipline` block (default
OFF → zero behaviour change)** that runs those same three rails on the paper book, self-resetting (daily clears
at UTC midnight; streak/drawdown clear after a `cooldownHours` window so a paused account never latches off).
Measured with a new tool, `npm run disciplineedge` — **on TWO books** (2548-trade no-lookahead stream,
SOL/BTC/ETH 1h, ~250 days, fixed stop/target exit, causal basket-regime — absolute % is a proxy; the OFF-vs-ON
delta *within a book* is the signal). It's important to measure the right book: the *unfiltered* book has no
edge, so it loses with or without a breaker.

**STRATEGY book (unfiltered — every regime, a STRUCTURAL LOSER by design):**

| Config | return | max DD |
|---|---|---|
| OFF (today) | **−38.4%** | 66.2% |
| ALL rails (25/4/10%) | −35.9% (+2.5) | 48.2% (−27%) |
| consecutive-loss only | +7.2% (+45.6) | 44.7% (−32%) |
| drawdown only | −16.6% | 47.8% |

**FILTERED book (bear-only — the account with the actual edge; where the breaker is recommended):**

| Config | return | max DD |
|---|---|---|
| **OFF (today)** | **+19.5%** | 14.3% |
| ALL rails (25/4/10%) | **+33.1% (+13.6)** | 12.1% (−15%) |
| consecutive-loss only | +14.9% (−4.6) | 15.9% |
| daily-loss only | +15.7% (−3.8) | 16.9% |
| **drawdown only** | **−9.8% (−29.3)** | 22.8% |

**What this actually says (corrected — an earlier draft measured only the losing unfiltered book):**
- **A circuit-breaker is a RISK control; it can't create profit.** The *unfiltered* book is negative with or
  without it — that book has no edge (bleeds outside downtrends), which is the bot's documented truth, not the
  breaker's doing. All it does there is shrink the bleed.
- **On the FILTERED book (the +19.5% one you'd actually run), the effect is MIXED and rail-dependent:**
  - The **drawdown rail is HARMFUL** (−29pp!). It's reactive — it only pauses *after* you're already down 10%,
    then pauses through the *recovery*, locking in the drawdown and missing the bounce. **Don't drawdown-halt a
    book with an edge.**
  - The **consecutive-loss and daily rails are ~neutral-to-slightly-negative** here. The streak rail's big win
    on the unfiltered book was **regime-avoidance** (losses cluster in bad regimes); once you *already* filter
    by regime, that value is **redundant** (same lesson as the flow gate — §2e of the overnight report).
  - **ALL rails combined looks strong (+13.6pp / −15% DD)** via an early-intervention path effect (daily+streak
    pauses stop you digging the holes the drawdown rail would else react to). BUT its component rails each
    *individually* underperform baseline → this is **path-dependent and in-sample; treat it as an unproven
    hypothesis, not a settled +13pp.** Validate OOS (`walkforward`) before trusting it.

**Bottom line:** default **OFF** is right. Turning it on is at best a **marginal, unproven** move on the edge
book, and the **drawdown rail actively hurts** it. If you experiment, use it on the **`strategy` account** (to
make its record honest / less ugly) and **avoid the drawdown rail**, and prove any return claim OOS. This is a
**discipline / record-honesty** feature, not a return lever — consistent with the through-line above. New tool:
`npm run disciplineedge`. Tests: +12 in `selftest` (177 total).

---

## Addendum — 2026-07-14 · book walk-forward (net of fees) + timeframe — the honest reckoning

Built `npm run bookwalk`: a walk-forward of the WHOLE book (`signalsAt` = the real strategy + S/R signals the
account trades), net of taker fees, over ~250d–16y of history in 8 chronological folds (every fold is OOS —
the strategies are never fitted). This is the most important — and most sobering — measurement in this file.

**At 1h (net of 5bps taker), the book does NOT clear costs:**

| Book | Gross | −Fees | **Net** | Positive folds |
|---|---|---|---|---|
| strategy (unfiltered) | +0.026R | 0.126R | **−0.100R** | 2/8 |
| filtered (bear-only) | +0.059R | 0.104R | **−0.045R** | 2/8 |

The gross signal edge is **real but tiny** (and the bear filter still ~doubles it, +0.026→+0.059R gross — every
prior finding holds). But **taker fees eat it whole.** The live "+0.10R on 11 trades" was small-sample luck;
on 2,560 trades net of fees it's negative. **This corrects the earlier optimism — those +0.2R figures were
GROSS.** It's a *fee-dominated* book, not a no-signal one.

**Timeframe is the lever (fees scale with how tight the stop is):**

| TF | fee drag/trade | strategy NET | filtered NET |
|---|---|---|---|
| 1h | 0.126R | −0.100R | −0.045R |
| 4h | **0.055R** | −0.023R (near BE) | −0.013R (near BE) |
| **1d** | **0.018R** | **+0.049R** ✱ | −0.036R (n too small) |

Wider stops on higher TFs mean far less fee-per-R (0.126 → 0.018R). At **1d the unfiltered book turns
net-POSITIVE (+0.049R)** — the first config that clears fees. ✱ **But it's fragile:** only 4/8 folds positive,
n=628, volatile fold-to-fold — *encouraging, not confirmed.* Note the flip: at 1d the **bear filter HURTS**
(over-filters daily bars → n=214, gross negative), so the daily edge lives on the *unfiltered* book.

**The two levers — both measured, both real, neither is curve-fitting:**
1. **Higher timeframe** (4h/1d — far less fee drag). 1d unfiltered = net +0.049R at taker (fragile).
2. **Maker/limit fills** (≈2bps vs 5bps taker). Measured — this **flips 4h positive** and lifts 1d further:

| config | strategy NET | filtered NET |
|---|---|---|
| 1h taker (today) | −0.100R | −0.045R |
| 4h **maker (2bps)** | **+0.009R** | **+0.017R** |
| 1d taker | +0.049R | −0.036R (n small) |
| 1d **maker (2bps)** | **+0.059R** | −0.025R (n small) |

So there **are net-positive configurations** — trade a **higher timeframe with maker (limit) fills.** The
**1d unfiltered** book is strongest (~+0.05–0.06R net) but fragile (4/8 folds, n=628); **4h + maker** is more
modest (+0.01–0.02R) but on a bigger, steadier sample (n=2248). Both still need forward validation. `bookwalk`
takes `INTERVAL=` and `FEE_BPS=` env overrides.

**Full timeframe × fee sweep** (net R/trade · folds-positive of 8; `bookwalk` FEE SWEEP block):

| TF | book | 5bps taker | 2bps maker | 0bps |
|---|---|---|---|---|
| 1h | unfiltered | −0.100 (2/8) | −0.024 (3/8) | +0.026 (3/8) |
| 1h | bear | −0.045 (2/8) | +0.017 (3/8) | +0.059 (6/8) |
| 4h | unfiltered | −0.023 (4/8) | +0.009 (5/8) | +0.031 (5/8) |
| **4h** | **bear** | −0.013 (5/8) | **+0.017 (6/8)** | +0.037 (6/8) |
| 6h | unfiltered | **−0.052 (1/8)** ⚠ | −0.029 (3/8) | −0.014 (4/8) |
| 6h | bear | −0.054 (3/8) | −0.032 (3/8) | −0.018 (4/8) |
| **12h** | **unfiltered** | **+0.074 (4/8)** | **+0.090 (5/8)** | +0.100 (5/8) |
| 12h | bear | +0.047 (3/7) | +0.063 (3/7) | +0.073 (3/7) |
| 1d | unfiltered | +0.049 (4/8) | +0.059 (4/8) | +0.066 (4/8) |
| 1d | bear | −0.036 (3/7) | −0.025 (3/7) | −0.017 (3/7) |

**Honest read:**
- **Best magnitude that clears *taker* fees: 12h unfiltered (+0.074R).** 1d unfiltered is close (+0.049R). Both
  are the only configs net-positive at full taker cost.
- **Most *stable*: 4h bear + maker (+0.017R, 6/8 folds).** Thin, but the most fold-consistent positive.
- **The bear filter flips usefulness by timeframe** — it *helps* intraday (1h/4h: more folds, higher gross) and
  *hurts* on daily (1d bear is negative). So the "best" config is TF-dependent: intraday→filtered, daily→unfiltered.
- **⚠ Big caveat — it's fragile/TF-sensitive, not a rock-solid edge.** No config is positive in more than 6/8
  folds, and **6h is net-*and-gross*-negative** while 4h/12h/1d are positive. A truly robust edge wouldn't break
  at one timeframe like that. So the daily/12h positives are **promising hypotheses, not a green light** — they
  could be partly TF-specific luck. Needs a clean train/test + per-symbol validation before any capital.

**VALIDATION VERDICT (2026-07-14 — the higher-TF "edge" FAILS out-of-sample):** ran per-symbol + a 70/30
train/test time-split + an outlier check on the unfiltered book (net of 5bps taker; `bookwalk` VALIDATION block):

| check | 12h unfiltered | 1d unfiltered |
|---|---|---|
| per-symbol | SOL +0.13 / BTC +0.04 / ETH +0.05 (all +, SOL carries) | SOL +0.06 / **BTC −0.05** / ETH +0.13 (inconsistent) |
| **train → held-out test** | **+0.117R → −0.025R** ❌ | **+0.081R → −0.026R** ❌ |
| minus top-3 winners | +0.074 → +0.048R (robust) | +0.049 → **−0.008R** (outlier-driven) |

**Both timeframes are strongly positive in-sample and NEGATIVE on the held-out test.** That's the classic
overfit signature — the "+0.05–0.07R" was the *earlier* period; on unseen recent data it's negative. The 1d
edge is additionally fragile (BTC negative, dies without 3 trades). **So the promising higher-TF configs were
in-sample luck, not a robust edge.**

### 🏁 Bottom line of the whole edge hunt (honest)
**No validated net-positive edge exists on any timeframe as measured.** 1h is fee-dominated (net-negative);
4h/12h/1d looked positive in-sample but **fail out-of-sample**; 6h is negative outright. The *gross* signal
edge is real but thin, and realistic fees + honest OOS testing erase the *net* edge everywhere. **Do not trade
this live for profit as-is.** It remains a legitimate decision-support / research tool with a thin, unproven
edge — the right use is paper, learning, and discipline, not a live money-maker. (Caveats: single train/test
split, small higher-TF samples, fixed-exit model — this is strong evidence against a robust edge, not absolute
proof one can never exist; but the burden of proof is on finding one, and we haven't.)

**Bottom line (harsh but true):** at **1h taker fees, do NOT trade this live — it doesn't clear costs.** The
signal is real but thin; the realistic route to a *net* edge is **fewer, higher-timeframe trades and/or maker
fills.** Finding this on paper, before risking a cent, is the whole point.

### Also 2026-07-14 · gold (XAUT) added for observation
`XAUTUSDT` (tokenized gold) added to the watchlist by user request — an *uncorrelated* asset (diversifies
rather than concentrating risk, unlike another coin). Decoupled the regime basket into `config.strategies.regimeSymbols`
(crypto-only) so gold does NOT poison the bear-regime signal. Honest caveat: the strategies/confluence are
crypto-tuned and **unmeasured on gold** — it's observational (watch it on the `strategy` account; the filtered
account gates it by crypto's regime, which is meaningless for gold).

**Gold verdict (`bookwalk` WATCHLIST=XAUTUSDT): NO PULSE.** The strategies are *gross-negative* on gold
(4h: gross −0.057R, net −0.175R, win 27%; train −0.115R → test −0.312R), and XAUT futures has only ~99 days of
history (tiny sample). As expected — gold behaves nothing like crypto, and these detectors don't transfer.
**Keep XAUT for *observation* only (price/regime on the dashboard); it will just bleed on the paper accounts.**
Remove it (drop from `watchlist`) if you don't want the noise.

---

## Addendum — 2026-07-15 · two news-proxy guards (`volFilter` + `newsBlackout`, opt-in, default OFF)

**Why they exist.** Live, on a CPI-release day, the `strategy` account took several entries into the data drop
and stopped straight out; the bot is **news-blind**. These two guards are honest *damage control* — a way to sit
out the convulsion — **not** an edge. Both are **default OFF** (zero behaviour change until you flip them); both
are pure, unit-tested helpers (`volSpikeBlocks` / `inNewsBlackout`, +16 tests → 193 total) gated at the top of
`paperOpen`.

- **`config.paper.volFilter`** — blocks a new entry when the just-closed candle's range > `spikeMult`×ATR(`atrLookback`)
  (default 2×ATR14). A cheap, **external-data-free** proxy for "something violent is happening right now."
- **`config.paper.newsBlackout`** — pauses new entries inside **scheduled** UTC windows you set (recurring daily +
  one-off events). **Schedule-driven on purpose** — a live feed can fail silently and you'd never know it stopped
  guarding. Default window covers the US 8:30-ET data slot (~12:30 UTC), weekdays only. **Not backtestable here**
  (no historical event calendar in the repo), so it's shipped measured-for-correctness but unmeasured-for-edge.

**Vol-spike MEASUREMENT (`bookwalk`, 4 symbols @ 1h, ~108d common window, net of 5bps taker) — it does NOT help,
and on the edge book it HURTS:**

| Book | full | → filtered (spikes skipped) | skipped bucket |
|---|---|---|---|
| strategy (unfiltered) | −0.166R (n=1225) | −0.168R (n=1147, −78) | **−0.136R** · win 40% |
| filtered (bear-only) | −0.055R (n=345) | −0.068R (n=319, −26) | **+0.104R** · win 50% |

Only **6.4%** of entries fire on a spike candle. Counter-intuitively, those spike entries are **not** where the
losses cluster — on the unfiltered book they're slightly *better* than average (−0.136 vs −0.168 kept), and in
the **bear regime they're the best trades in the book** (+0.104R, 50% win). So skipping them makes both books
*worse*. On this 1h setup a volatility spike is a **conviction breakout/breakdown signal, not a danger sign** —
exactly the entries a short-biased trend-follower wants. **Verdict: keep `volFilter` OFF.** It's available for the
user to flip, but the data says it removes good trades, not bad ones. (Caveat: 1h/2×ATR14 catches only the most
extreme candles; a live intrabar news whipsaw on a *lower* TF, or the exact CPI-minute, isn't fully represented
by this bar-close backtest — the guard may still cushion a live account subjectively even though it doesn't lift
measured expectancy. That's a comfort/discipline call, not an edge claim.)

**News-blackout:** cannot be measured without event data, so no expectancy claim is made. It's a discipline knob —
if you *know* CPI/FOMC is at a time, blacking it out avoids a coin-flip; but that's avoiding variance, not adding
edge. Neither guard changes the bottom line below.

---

## Addendum — 2026-07-15 · asset character + the "famous strategy?" survey (do momentum-longs or a gold strategy exist?)

Prompted by "what else can we do — anything for gold, any famous strategy?" Rather than guess which famous
system to bolt on, I **measured what each asset IS** (`npm run assetchar`) and then tested the one lead the data
gave (`npm run trendedge`). Two new keepable research tools; both net of 5bps/side taker.

**1. Asset character (`assetchar`) — trend vs mean-reversion, session, and does fade/follow pay?**
- All four assets are **weakly mean-reverting** (1h return autocorr ≈ 0, variance-ratio VR4 ≈ 0.95–1.00) — but
  the reversion is **sub-fee**: a z-move **FADE** (contrarian) has a **negative** forward return net of fees for
  *every* asset, *every* z-threshold, *every* horizon. RSI2/Bollinger-style reversion **cannot clear costs at 1h.**
- The **only** positive raw signal in the whole sweep: **Donchian-20 breakout continuation** at multi-day holds on
  crypto (BTC +0.29%, SOL +0.18%, ETH +0.23% over 24–48h, net) — the classic trend/momentum signature.
- Session: crypto vol peaks in the **NY session (13–21 UTC)**; **gold's only real structure is dead weekends**
  (per-bar vol **0.06% weekend vs 0.20% weekday** — the underlying gold market is closed, so weekend XAUT is thin,
  gappy, non-price-discovering).

**2. The trend lead, tested honestly (`trendedge`) — a real turtle system, NOT a time exit.**
Donchian-20 entry, 2×ATR20 stop, 10-bar opposite-break exit (lets winners run — a fixed target would cap exactly
the trend profit). The raw breakout edge **does not survive stops**:

| | overall | LONG | SHORT |
|---|---|---|---|
| 1h (n=629) | **−0.056R** | **−0.185R** (dead) | +0.062R |
| 4h (n=307) | **−0.031R** | −0.072R | +0.014R |

- **The LONG side loses on every asset** (1h all-long −0.185R; held-out −0.22R). This is decisive: the earlier
  finding that oversold-**bounce** longs lose was about *mean-reversion* longs — this tests *momentum/breakout*
  longs, a different hypothesis, and **they lose too.** The bot's **short-only character is now doubly confirmed
  structural**, not a tuning gap or a missing-strategy gap.
- Only **SHORTS** are mildly positive (BTC short +0.16R, ETH short +0.20R at 1h) — i.e. the turtle just rediscovers
  the **same short-trend edge the bot already has.** No *new* edge. OOS sign-flips between train/test and 1h/4h, so
  it isn't even a robust standalone version of that edge.
- **Gold: no edge in any direction** — turtle 1h −0.15R, 4h −0.64R; fade negative; breakout negative. Gold long
  −0.49R. Confirms the earlier "no pulse" verdict from a second, independent angle.

**Famous-strategy survey (mapped to the measured character + the already-rejected list):**

| Family | Verdict here |
|---|---|
| Trend / CTA / Donchian / TSMOM | **Already the bot's edge** (short trend-follow). Longs dead; no new return. |
| Mean-reversion (RSI2 / Bollinger / VWAP) | Assets do revert but **sub-fee at 1h** — fade loses net. Dead on arrival. |
| Stat-arb / pairs (SOL/ETH/BTC) | **Already tested, loses** (majors drift, don't co-revert). |
| Carry / funding-rate harvest | *Untested here, plausible but not a directional edge* — a market-neutral yield play needing a hedge leg + funding data; a different machine than this bot. The one genuinely-new **measurable** idea. |
| Cross-sectional momentum | Only 3–4 correlated symbols → too few to rank; not enough breadth to work. |
| Order-flow / microstructure | Order-flow already stacked as a confluence factor (measured: helps but **redundant** with the regime filter). |
| Vol-targeting position sizing | A **risk-smoothing** lever (vol clusters, autocorr\|r\|² ≈ 0.12–0.20), **not** a return lever — like the regime filter. |
| ML / regime-switching / sentiment / on-chain | Not robustly measurable on ~110–190 days + no news/tick/options data; high overfit risk, low prior. |

**Bottom line (2026-07-15):** there is **no famous-strategy silver bullet** hiding here, and **no gold strategy** —
the data closed both doors from multiple angles. The short-only, downtrend-only character is structural. The only
*new* thing worth a cheap measurement is **funding-rate carry** (a different, market-neutral machine), and the only
*useful* gold action is a **weekend blackout** (which the new `newsBlackout` knob already expresses) or dropping it.
Everything else is risk-control (already have the regime filter) or rearranging deck chairs.

---

## Bottom line

**Realistic backtest: ~+29% over ~2 months, ~11% max drawdown, profit factor ~1.7** — *with honest
fills* (see "The fill-honesty correction"). Earlier figures near +84% were inflated ~3× by a
fill artifact and are **not** trustworthy. +29% is the number to plan around, before real-world
funding and additional slippage.

The edge is **real but modest**, and concentrated in one strategy. This is a genuine, disciplined
retail signal system — not a money printer. Prove it on paper, then decide. The one robust improvement is
the **bear-only filter** (risk control). *(I initially flagged widening the watchlist as "growth" — a
portfolio test corrected it: correlated alts concentrate risk and ~double drawdown, so the **narrow
SOL/BTC/ETH filtered book is actually better risk-adjusted.** See item 4.)*

**But that +29% is regime-conditional, not skill.** Measured across **311 days and 33 windows**
(`npm run regimealpha`), the bot is a **short-biased trend-follower**: it averages **+8.9%** in bear
windows (81% profitable) but **−9.8%** in bull windows and **−9.7%** in flat/chop. Its return is
*negatively* correlated to crypto (cross-window slope −0.63). The headline looks great only because the
recent sample was bearish — **in a bull year this same bot loses money.** The reel's critique was "you're
riding crypto *up*"; the truth is we ride it *down* — either way it's directional beta, not market-neutral
skill. **The fix that measures:** a causal *bear-only* market-regime filter (`npm run regimeoverlay`) roughly
**halves drawdown** (holds in- *and* out-of-sample: ~10% vs 17–31%) and lifts the in-sample account to +31% —
but out-of-sample its *return* edge doesn't clearly beat baseline, so treat it as **risk control, not a return
machine**. See [Alpha vs beta](#alpha-vs-beta--skill-or-riding-the-market).

---

## Recommended actions (what to actually do)

The whole analysis distilled to decisions:

1. **Make the paper account honest** — set `config.plan.confirmEntryAtClose = true`. Confirmations then book
   *real* fills instead of the ~3× inflated phantom-limit fills, so the track record is trustworthy. *(Do this.)*
2. **Restart the bot** — `cd alertbot && npm start`. Nothing measured here is live until you do; the running
   instance is stale.
3. **Let it run** — the honest paper account + inline ✓WON/✗LOST badges are the real proof. A backtest can't
   substitute for a live, out-of-sample sample.
4. **Lower risk (optional)** — `config.strategies.marketRegimeFilter = true`: trades only in downtrends,
   **~½ the drawdown**. It won't raise return (it's risk control), and the bot sits idle ~⅔ of the time.
5. **Watchlist: keep it NARROW** — `SOLUSDT,BTCUSDT,ETHUSDT` (the default). The per-trade edge generalizes to
   alts, but a portfolio test (3 vs 4 vs 7, all filtered) showed widening only *concentrates* correlated-short
   risk — ~2× drawdown at 7 symbols for **no** extra return. The narrow filtered book is the best risk-adjusted
   config (item 4). Add at most 1 coin (e.g. XRP) only if you specifically want the coverage.

**Honest expectation:** a disciplined **short-trend-follower** with a real but *modest, edge-capped* return
(~+29% in-sample over a bearish 2 months; no tuning found more per-trade return). It earns shorting
downtrends, bleeds in bull/flat. Prove it on paper — never autopilot.

---

## Which strategies actually work (expectancy = avg R per trade, honest fills)

| strategy | trend regime | range regime | verdict |
|---|---|---|---|
| **breakout-retest** | **+0.53R** | −0.28R | **the robust core** — strong in trends, holds across every time-fold |
| momentum-TSMOM | +0.22R | −0.30R | real edge in trends only; regime-dependent |
| bollinger-reversion | ~0 (flat) | +0.17R | a range specialist |
| **S/R confirmation** (founding feature) | +0.095R | **+0.20R** | honestly +EV in both regimes, best in ranges |

**breakout-retest is your anchor.** It's the only source that stayed positive in every chronological
walk-forward fold (+0.22 / +0.21 / +0.11 R). The others are genuinely +EV but regime-dependent —
which the bot already handles naturally (below).

Disabled by the audit (measured break-even or negative): trend-pullback, vwap-reversion,
sweep-reversal, standalone order-flow-imbalance, order-block trading.

**1h is the right timeframe** (`npm run timeframe`) — for the bear-short edge, 1h (+0.228R) beats 4h (+0.111R)
and 15m (+0.077R). 4h is marginally better on the *full* signal population (less noise) but weaker on the
trades that matter, and 15m is noisiest. Your timeframe choice is validated — no reason to switch.

---

## Alpha vs beta — skill, or riding the market?

The classic quant critique of any bot deserves a measured answer, and we now have two tools for it.
`npm run alpha` regresses the bot's per-bar mark-to-market returns on an equal-weight SOL/BTC/ETH basket
(Jensen's alpha, rf≈0, plain-OLS) over one recent window; `npm run regimealpha` slides that same analysis
across many months to test whether the edge holds in *every* regime. Built-in controls (basket-on-basket
→ β≈1/α≈0, all-cash → β≈0, 2×→β≈2) validate the math.

**Single recent window** (~60 days, a *bear* window): bot **+29%** vs market **−21%** — a +50-point spread,
net-**short** ~74% of bars, β **−0.30** (t −13, highly significant). So it's genuinely **not long-beta**; it
made money *because* crypto fell and it was short. But the residual "skill" alpha isn't significant (t≈1.2)
on one window — so this alone can't separate trend-luck from skill.

**Many windows** (`npm run regimealpha`, **311 days, 33 windows**, each classified by its own market move) —
this is decisive:

| regime | windows | avg market | avg bot | avg residual α | bot profitable |
|---|---|---|---|---|---|
| **bull** | 7 | +7.0% | **−9.8%** | −12.0% | **14%** |
| **bear** | 21 | −19.8% | **+8.9%** | +4.0% | **81%** |
| **flat / chop** | 5 | −0.3% | **−9.7%** | −9.7% | 20% |

Cross-window slope of bot-return on market-return: **−0.63** (corr −0.52).

**The verdict — a short-biased trend-follower, not market-neutral skill.** The bot harvests big down-moves
(+8.9% avg, 81% win in bear windows) but **bleeds in rallies (−9.8%) and chop (−9.7%)**. Its profitability
is *conditional on crypto falling*. The +29% headline exists only because the recent sample was bearish
(21 bear windows vs 7 bull). **In a sustained bull market, this same bot loses money.** The reel's critique
was "you're riding crypto *up*"; the truth is we ride it *down* — either way, directional beta, not alpha.

**Leveling up — the measured next steps:**

1. **✅ MEASURED — a causal broad-market regime filter is the #1 lever.** `npm run regimeoverlay` replays the
   full 312-day account under overlays that gate *new* entries by the **trailing (no-lookahead)** basket regime:

   | overlay | return | maxDD | ret/DD | Sharpe |
   |---|---|---|---|---|
   | baseline (trade everything) | +6.1% | 31.0% | 0.20 | 0.39 |
   | **bear-only** (enter only in trailing downtrends) | **+31.2%** | **13.5%** | **2.31** | **1.86** |
   | skip-bull (trade bear + flat) | +15.9% | 29.8% | 0.53 | 0.73 |
   | trend-aligned (long in bull / short in bear) | −13.2% | 28.4% | −0.47 | −0.57 |
   | combo *(⚠ overfit — see below)* | +45.5% | 17.9% | 2.55 | 1.77 |

   Trading only when crypto is in a trailing downtrend **halves the drawdown and 5×'s the return** (ret/DD
   0.20 → 2.31, Sharpe 0.39 → 1.86), and it's **robust — it beats baseline in 10 of 12 lookback×band cells**,
   not a single lucky point. Note the *full-history baseline is only +6.1%* — proof the +29% headline was a
   bearish-sample artifact. **✅ Built as an opt-in knob: `config.strategies.marketRegimeFilter` (default
   off).** Flip it to `true` and the paper engine pauses new entries unless the basket is in a causal
   downtrend (`marketRegimeLookback` 168 bars, `marketRegimeBandPct` 3%). It's a big behavior change — the bot
   sits idle ~⅔ of the time — so it's off by default; enable it deliberately, then validate forward.

   **⚠ Out-of-sample check (`npm run regimeoos`) — the honest caveat.** Splitting history chronologically
   (TRAIN = first 186 days, TEST = last 124), picking bear-only's params on TRAIN, then applying them frozen
   to the unseen TEST slice: bear-only did **NOT** beat baseline out-of-sample on *return* (+10.3% vs +17.4%,
   ret/DD 0.99 vs 1.01) — the best band on train (±5%) wasn't the best on test, so honest param selection gave
   a filter that merely *matched* baseline. What **did** hold out-of-sample is **drawdown**: bear-only's maxDD
   was ~10% on both train and test vs baseline's 30% / 17%. A **4-fold walk-forward** (params re-picked on
   expanding data each fold) confirms it across periods: bear-only beat baseline on **drawdown in 3/4 folds**
   but on **return in only 1/4**. **So the corrected read: bear-only is a reliable RISK-REDUCER (it
   consistently ~halves drawdown), not a dependable return-booster.** The in-sample +31% / 10-of-12 overstated
   the return edge. Use the filter as risk control; let live tracking be the final arbiter.

   **The regime-aware _combo_ looks even better at default params** — layering the +EV support-longs (item 2)
   onto the bear-short base returns **+45.5%** at ret/DD 2.55 (vs bear-only +31.2%). **But the robustness
   check tempers this decisively:** across the lookback×band grid the combo beats bear-only in **only 5 of 12
   cells** (while bear-only beats baseline in 10/12). It wins at L=168 / ±2–3% but not at wider bands or other
   lookbacks — so the combo's extra return is **param-sensitive, not robust**. **Verdict: bear-only is the
   robust, recommended default; the combo is a fragile return-booster and should NOT be productionized on this
   evidence.** The support-long edge is real *per-signal*, but it doesn't reliably lift the whole account over
   bear-only once you vary the regime detector. (This is measure-then-verify catching an overfit — the combo's
   +45.5% was tuned to one parameter choice.)

2. **The long side isn't dead — it's the founding support-bounce (measured).** `npm run longedge` splits
   every source's expectancy by regime × direction. The momentum/breakout/bollinger *longs* do bleed in
   bull/flat — but **`confirm-support` (your original S/R support bounce) is +EV exactly there: +0.25R in
   flat, +0.11R in bull** (n=140/82), while failing in bear (support breaks in downtrends). So "short-only"
   leaves money on the table: the richer level-up is **regime-aware** — support-confirmation LONGS in
   flat/range & bull, trend SHORTS in bear. This vindicates your original S/R instinct — the support bounce
   works, just in the right weather. (The `trend-aligned` overlay's −13.2% came from taking *all* longs,
   including the bad momentum ones — not the selective support long.) **Already tested at the account level
   (item 1's combo):** the selective support-long+bear-short combo beats bear-only at default params but is
   overfit (5/12) — the per-signal edge is real, but it doesn't robustly lift the whole account, so it's not
   productionized.

3. **Market-neutral variant** — hedge the directional exposure so the P&L is the residual, not the market call.
4. **⚠ CORRECTED — widening the watchlist is NOT a portfolio win (correlation concentration).** The
   *per-trade* edge **does** generalize to alts (`npm run universe`: 7/8 +EV, holds OOS). **But at the
   PORTFOLIO level it doesn't help** — a direct 3-vs-7 test, *both bear-only filtered*, shows the **narrow book
   is strictly better:** 3 symbols **+31.2% / 13.5% DD / ret-DD 2.31** vs 7 symbols **+27.6% / 23.3% DD /
   ret-DD 1.19**. More correlated crypto shorts don't diversify — they **concentrate** the directional bet, so
   a market bounce hits them all at once: drawdown ~doubles and return doesn't even grow. **So the narrow
   (SOL/BTC/ETH) filtered book is the best risk-adjusted config**; widening adds raw trades but worse risk.
   *Lesson: per-trade expectancy ≠ portfolio benefit when the trades are all correlated — I first over-claimed
   widening as "growth" on the per-trade numbers, and the portfolio test corrected it.* (One in-sample window;
   re-check as data grows. NB: the filter is still essential on ANY watchlist — unfiltered-7 loses −15%.)

Caveats: one 312-day path; `regimeoverlay` picks its lookback (168 bars) + band (±3%) on the same data, so
its in-sample magnitudes overstate (the bear-only filter is separately checked **out-of-sample** via
train/test + a 4-fold walk-forward — see item 1's ⚠ box — where only the *drawdown* benefit survives);
`regimealpha` windows overlap. Directional evidence, not proof — live/forward tracking is the real test.

---

## The fill-honesty correction (important)

The paper account, by default, books **S/R confirmations as filled at the level** — but the
confirmation candle already closed *past* the level, so that limit order mostly never fills in
reality. Measured impact:

| model | expectancy | note |
|---|---|---|
| assume-fill (paper default) | **+2.93R** | a mirage — counts trades that never would have filled |
| require a real retest | −0.05R | break-even once you demand a fill (only ~59% of limits ever retest) |
| **enter at the candle close** | **+0.158R** | honest, immediate fill (36% win, PF 1.25) — the real edge |

**Fix:** set `config.plan.confirmEntryAtClose = true`. Confirmations then enter at the close (real
fills), your paper account becomes a *trustworthy* proof-of-profit, and confirmations keep a modest
+EV. Trade-off: confirmation R:R drops from ~11 to ~2–3, but the numbers become ones you'd get.
**Recommended on.** (Default off only to avoid silently reshaping the founding feature.)

---

## Regime: the bot is already "right strategy, right regime"

You don't need to force it — it's built into how strategies trigger. Momentum setups
(breakout-retest, TSMOM) only appear in trending/breaking markets; S/R confirmations only fire inside
a *consolidating range*; bollinger fades range extremes. So each tool already shows up in its own
weather.

Measured: **explicitly gating strategies by regime (`regimeGate: true`) makes the account slightly
worse** (+25.5% vs +29% ungated) — freeing a slot backfills with other trades, and breakout-retest's
occasional big range winners matter for compounding. **Leave `regimeGate` off.**

---

## Ideas tested and rejected (so you don't re-chase them)

Discipline this session was as much about *not* shipping clever-but-wrong ideas as building good ones:

- **Correlation position cap** — measured to *hurt* risk-adjusted return; correlated same-direction
  signals are usually a high-conviction move worth full participation, not a risk to throttle.
- **Statistical arbitrage (SOL/ETH/BTC pairs)** — loses on all three pairs (−8% to −10%); the majors
  *drift* against each other for weeks rather than mean-revert, so there's no tight spread to fade.
- **Force regime-gating** — helps each strategy in isolation but not the portfolio (see above).
- **The inflated confirmation P&L** — a fill artifact, corrected above.
- **The regime-aware combo** — beats bear-only at default params but overfit (5/12 cells); not productionized.
- **Exit management as a return lever** (`npm run exitedge`) — on the earning cohort (bear shorts, n=450) the
  current **fixed target (+0.217R) is already the best**; trailing stops, partial-TP, and time stops don't beat
  it. Trailing (2×ATR) roughly doubles expectancy on the *full* (marginal) signal population, and partial-1R
  raises win-rate to 58% for a *smoother* curve — but neither raises return on the trades that matter.
- **Trade selection by flow** (`npm run selectedge`) — requiring order-flow confirmation (aggressive taker
  delta) lifts the **unfiltered** short book meaningfully (+0.09R → +0.20R at usable n) but adds ~nothing to
  **bear-shorts** (+0.217 → +0.223R): it's **redundant with the regime filter** — both just select shorts in
  favorable conditions. A mild lever that *overlaps* bear-only, not additive.

- **Counter-trend bounce longs** (`npm run bouncedge`) — a NEW-edge attempt at the missing long side: oversold
  (RSI) longs in downtrends, exited to EMA20 or 2R. **Loses at every RSI threshold** (−0.18 to −0.34R, n up to
  648) and both targets — catching falling knives loses, and *deeper* oversold is *worse*. The long side isn't
  recoverable in downtrends; the bot's short-only character is **structural**, not a tuning gap.
- **RSI/CVD divergence alerts** (`npm run divedge`) — a feature the bot alerts on but never validated. Over
  deep history, no divergence type beats the market's own drift: bullish divergences are *anti*-predictive
  (−0.12 to −0.15pp over 24 bars), bearish barely edge baseline (+0.05pp), hit-rates ~48–51% (coin flip).
  **Divergences are noise as a standalone predictor** — fine as on-chart context, but don't trade or weight them.

**The through-line:** three separate return levers — regime-filter, exit-tuning, flow-selection — and **none
stacks to meaningfully higher return.** The bot's return is what its edge produces (~modest); the only working
improvements are risk-control (bear-only, ~½ drawdown) and smoothness (partial-TP). Beating that needs a
genuinely *new* edge — and the first new-edge hypothesis tested (oversold-bounce longs) already failed, so the
short-only, downtrend-only character looks **structural**. The bot is what it is: a disciplined short
trend-follower with a real but modest edge, best run with risk control, on an honest paper account.

Each was rejected (or bounded) by measurement, not opinion. That's the point.

---

## Measurement suite (re-run any before trusting a change)

```
npm run audit        # per-strategy expectancy + per-confluence-factor edge → feeds the Evidence Engine
npm run backtest     # single-symbol replay: win-rate by score + per factor
npm run portfolio    # all symbols, one shared balance — the realistic account trajectory
npm run walkforward  # split history into time folds — is each edge STABLE or regime-lucky?
npm run regimeedge   # every source's expectancy split by regime (trend/range/volatile)
npm run regimegate   # portfolio with vs without regime-gating
npm run pairs        # statistical-arbitrage research across the majors
npm run confirmedge  # confirmation edge under assume-fill vs honest-fill models
npm run alpha        # ALPHA vs BETA — regress the bot vs a crypto basket; is the return skill or market exposure?
npm run regimealpha  # slide the alpha analysis across 300+ days — does the edge hold in bull regimes, or only bear?
npm run regimeoverlay # does a causal bear-only market-regime filter lift the whole account? (measured: yes, ret/DD 0.20→2.31)
npm run longedge     # per-source × regime expectancy — is a LONG edge feasible in bull/flat? (yes: support-bounce +0.25R flat)
npm run regimeoos    # OUT-OF-SAMPLE (train/test split) — does the bear-only filter hold on unseen data? (drawdown yes, return no)
npm run exitedge     # trailing / partial-TP / time stops vs the fixed target — is the exit a return lever? (no)
npm run selectedge   # does order-flow confirmation lift return? (mild for unfiltered shorts, redundant with regime filter)
npm run bouncedge    # NEW-edge test: oversold-bounce longs in downtrends — is the missing long side recoverable? (no)
npm run divedge      # do RSI/CVD divergence alerts predict, or are they noise? (noise — don't trade them)
npm run timeframe    # 15m vs 1h vs 4h — is 1h the right timeframe for the edge? (yes)
npm run universe     # per-trade edge generalizes to alts (7/8 +EV) but widening CONCENTRATES risk — narrow is best risk-adjusted (item 4)
npm run bounceresolve # oversold bounce in a downtrend — continuation vs reversal? (66% reclaim the EMA first; short-the-bounce ~break-even)
npm run test         # 129 unit tests (logic + OLS regression + regime classifier + market-filter gate + dual-account contract + dashboard integrity)
```

---

## Honest caveats

- In-sample, ~2 months, one timeframe. A tiny sample is noisy — the numbers will move as history grows.
- Paper trading still models only fees + stop slippage — no funding, no liquidation, no partial fills.
- The measured edge is an *estimate*, never a guarantee. The bot finds and simulates setups; **you**
  decide and execute real trades.
- The real proof is the live track record on the honest config — which the inline WON/LOST alert
  badges and `npm run walkforward` are built to judge over a real sample.
