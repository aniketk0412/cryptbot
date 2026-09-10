# Session summary — self-paced /loop work (2026-07-17)

*What got built while you were away, the honest state, and the decisions that are yours to make.
Full detail lives in `EDGE-REPORT.md` (2026-07-17 addenda); this is the digest.*

---

## The honest headline (unchanged)

**The bot still has no validated, net-positive edge.** Everything below refines *how marginal / where*, not
*whether* — the answer to "is it profitable" remains **no, not reliably.** The best configuration found is a
**marginal, fragile 4h momentum book** that a proper walk-forward keeps landing at ~50% of windows positive.

## Research done this session (5 findings, all measured, all in `EDGE-REPORT.md`)

| # | Probe (`npm run …`) | Finding |
|---|---|---|
| 1 | `chainedge` | Stacking confluence factors does **NOT** lift win rate — flat ~35% regardless of "chain length"; high-confluence buckets are n=6–7 noise. Confluence-as-filter is dead. |
| 2 | `rrsweep` | On the 4h book, **fixed R:R targets are all net-negative**; a **trailing-3ATR** exit is the only net-positive one (momentum wants to run). |
| 3 | `rrsweep` walk-forward | Trailing-3ATR is **real, not in-sample luck** — pooled OOS **+0.041R, 18/35 folds** vs 2R-fixed +0.006R. Still MARGINAL. |
| 4 | `rrsweep` per-symbol | The 4h edge is **concentrated in BTC** (+0.118R OOS, 51%) and SOL; **ETH actively drags** (−0.066R, fails). |
| 5 | `rrsweep` BTC/SOL-only | Dropping ETH roughly **doubles** the marginal edge (pooled OOS +0.091R, 54%) — **but that's post-hoc selection**, so inflated, and still fails ~half the windows. |
| 6 | `fundingedge` | **Funding-rate carry (the last untested lever) is dead too** — basket ≈ −0.8%/yr gross (SOL −3.6%, BTC +1.0%, ETH +0.1%); thinner than the frictions to capture it, and a different (hedged) machine anyway. |

New reusable tools: **`npm run chainedge`**, **`npm run rrsweep`** (env: `RR_SYMBOLS`, `RR_DAYS`, `WFA_TEST_DAYS`), **`npm run fundingedge`**.
**Research is now comprehensively exhausted** — every lever (momentum, reversion, confluence, S/R, exits, per-symbol, timeframes, funding carry) has been measured; none is a robust net-positive edge.

## UI polish done this session (all rebuilt + verified in-browser)

Social-media-grade animations on the "Candela" dashboard (`app/App.tsx`, served at `localhost:1000/app`):
- **Animated trade cards** — staggered fade-in entrance, P&L-colored left accent + tint + soft glow (green win / red loss).
- **Rolling P&L** (`AnimatedPnl`) — the dollar value smoothly counts to its new number as price moves.
- **Gauge live-price glide** — the price marker/arrow slide smoothly on each tick instead of jumping.
- **Regime-glow MKT badge**, **account-card equity accent/glow**, **glowing sliding tab indicator**, **staggered alerts list**.
- Fixed a stale label (`Filtered · bear-only` → `regime-gated`).

## Live forward-test standings (the 3 paper accounts, as of this write-up)

- **`strategy`** (1h, unfiltered): ≈ **−2.3%** over 20 closed trades — **50% win but live expectancy −0.070R**. This is the live account *confirming the backtest's negative verdict*: it wins half its trades and still bleeds on fees, exactly the fee-drag finding.
- **`filtered`** (1h, bull/flat gate): ≈ **flat** (few/no entries).
- **`core_4h`** (4h, unfiltered momentum): ≈ **−0.6%**, a handful of open trades — the forward-test of the marginal 4h edge, just getting started (needs weeks of closed trades to mean anything).

## Decisions that are YOURS to make (I did not touch live money-code)

1. **`core_4h` exit:** the data favors a **trailing-3ATR** exit over the 2R target — worth setting `trailAtrMult≈3` **for core_4h only** (I did not flip it: it's a global config and in-sample-selected). Forward-test it.
2. **`core_4h` symbols:** BTC/SOL look meaningfully better than including ETH — but that's post-hoc selection; only forward data settles it. Watchlist unchanged.
3. **Reality check:** none of this makes the bot a money-maker. The right frame remains: an honest paper/research/discipline tool, with `core_4h` gathering live evidence on a marginal candidate.

---

*Bottom line: the dashboard is genuinely polished, the research is thoroughly mapped, and the honest verdict is
intact — a marginal, fragile edge worth watching forward, not a validated profitable system.*
