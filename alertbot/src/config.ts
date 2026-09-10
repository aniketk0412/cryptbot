/** All tunable knobs. Edit these to fit the market/timeframe you trade. */
export const config = {
  // ---- What to watch (USDⓈ-M futures) ----
  symbol: process.env.SYMBOL ?? "SOLUSDT", // primary symbol (manual levels + backtest apply here)
  interval: process.env.INTERVAL ?? "1h",
  binanceBaseUrl: "https://fapi.binance.com", // Binance USDT-M futures
  // Watchlist — every symbol here is scanned each cycle and shown on the dashboard.
  // The primary `symbol` uses manual levels if set; the rest use auto range detection.
  // Default = SOL/BTC/ETH — the MEASURED-BEST risk-adjusted set. The per-trade short edge DOES generalize to
  // liquid alts (`npm run universe`), but widening the watchlist CONCENTRATES correlated-short risk: a direct
  // portfolio test (3 vs 4 vs 7, all bear-only filtered) is monotonic — every added coin raises drawdown
  // (~2× at 7) for NO extra return. Add at most 1 (e.g. XRP) only if you specifically want the coverage.
  // XAUTUSDT (tokenized gold) added by user request as an OBSERVATIONAL asset — it's *uncorrelated* to crypto
  // (different asset class), so unlike adding another coin it diversifies rather than concentrating risk. BUT
  // the strategies/confluence are crypto-tuned and UNMEASURED on gold, and the bear filter reads a crypto-only
  // basket (`regimeSymbols`), so gold's filtered-account trades are gated by *crypto's* regime (meaningless for
  // gold — watch it mainly on the `strategy` account). Remove it / override with the WATCHLIST env var.
  watchlist: (process.env.WATCHLIST ?? "SOLUSDT,BTCUSDT,ETHUSDT,XAUTUSDT").split(",").map((s) => s.trim()),

  // ---- Levels: how support/resistance are chosen ----
  // "auto":   derive them from the consolidation range (high/low over lookback).
  // "manual": watch FIXED levels you set (RESISTANCE / SUPPORT in .env). Best when
  //           YOU have drawn the levels (order block etc.) — a pure high/low auto
  //           range grabs lone wicks, not the level where price actually reacts.
  // Setting RESISTANCE and SUPPORT in .env auto-switches to manual mode.
  levelMode: (process.env.RESISTANCE && process.env.SUPPORT ? "manual" : "auto") as "auto" | "manual",
  manualResistance: Number(process.env.RESISTANCE ?? 0),
  manualSupport: Number(process.env.SUPPORT ?? 0),

  // ---- Consolidation detection (auto mode) ----
  // The range is the high/low over the last `lookback` CLOSED candles.
  lookback: 24,
  // Candles pulled per scan. Must exceed the hungriest consumer: strategies need
  // up to 60, regime needs emaSlow (50), VWAP uses 48. 150 gives all of them room.
  candleHistory: 150,
  // It only counts as "consolidating" (and the bot only alerts) when the range
  // is tighter than this. Widen to catch bigger ranges; tighten for coiled ones.
  maxRangeWidthPct: 6,
  // Ignore absurdly tight ranges (usually dead/illiquid periods).
  minRangeWidthPct: 0.4,

  // ---- Touch & confirmation ----
  // Price within this % of a level counts as a "touch".
  touchTolerancePct: 0.15,
  // Price must pull this far away from a level before that level can alert again
  // (stops the same touch from spamming you).
  rearmTolerancePct: 0.5,
  // A candle that CLOSES beyond a level by this margin = a breakout (the range
  // broke instead of holding). Small margin filters out marginal pokes.
  breakoutMarginPct: 0.1,

  // ---- Loop ----
  pollIntervalSec: 20,

  // ---- Alerts ----
  alertOnTouch: true,
  alertOnConfirmation: true,
  alertOnBreakout: true,

  // ---- Order-flow confirmation (stacked confidence on confirmation alerts) ----
  orderflow: {
    enabled: true,
    depthLimit: 100, // order book levels to pull
    depthBandPct: 0.3, // count bid/ask liquidity within this % of the level
    imbalanceThreshold: 0.55, // share on the defending side to count as a "wall"
  },

  // ---- Price-structure confluence (SMC / ICT factors) ----
  structure: {
    fvgBandPct: 0.4, // an FVG/IFVG counts if its zone is within this % of the level
    sweepLookback: 10, // candles that define the swing a sweep must take out
    pdLookback: 60, // window for premium/discount (equilibrium) read
    structureLookback: 20, // window for the BOS/CHoCH trend read
    htfInterval: "4h", // higher timeframe for bias alignment
    htfEmaPeriod: 20, // EMA on the HTF to define its trend
  },

  // ---- Divergence detection (RSI & CVD vs price) ----
  divergence: { enabled: true },

  // ---- Failed-breakout / reclaim reversal ----
  // Price CLOSES out of the consolidation range, then CLOSES back inside within
  // reclaimWindow candles = a trapped breakout (bull/bear trap). Fires a reversal
  // alert + plan that fades the failed move back toward the opposite side.
  reversal: {
    enabled: true,
    reclaimWindow: 6, // candles after a breakout that a snap-back still counts as a failed breakout
    minRR: 1, // skip reclaim setups whose reward:risk is below this
  },

  // ---- Volume Profile (POC / Value Area over a recent window) — sharper S/R context ----
  volumeProfile: {
    enabled: true,
    lookback: 120, // candles in the profile window
    bins: 50, // price buckets
  },

  // ---- Liquidity Sweeps (port of LuxAlgo indicator, "Only Wicks" mode) ----
  sweeps: {
    enabled: true,
    len: 5, // pivot swing length (LuxAlgo "Swings" default)
  },

  // ---- Order Block Finder (port of wugamlo's TradingView indicator) ----
  orderblocks: {
    enabled: true,
    tradeRevisit: false, // audit: -16.3R net, PF 0.81 — auto-trading OBs disabled (detection/display below stays on)
    periods: 5, // consecutive candles after the OB candle
    thresholdPct: 0, // min % move over the sequence to validate a block
    useWicks: false, // whole high/low range vs open-based range
  },

  // ---- Strategies (each is a detector; more get added over time) ----
  strategies: {
    trendPullback: false, // not the range strategy (trades WITH trends) + break-even in audit (+0.001R) — disabled
    breakoutRetest: true,
    sweepReversal: false, // audit (SOL/BTC/ETH 1h): -2.0R net, PF 0.98 — disabled
    vwapReversion: false, // thin edge (+0.028R, below fees) + not the range strategy — disabled
    // Documented institutional / academic strategies:
    tsmom: true, // time-series momentum (Moskowitz, Ooi & Pedersen 2012)
    orderFlow: false, // audit: fires ~never as a standalone entry (n=3) — disabled. NB: the flow *confluence* factor stays (it's the single best factor, +21pp)
    bollinger: false, // Bollinger-band mean reversion — DISABLED 2026-07-15: the 2-year deepbacktest measured it the
    // single biggest drag (−0.182R net over 2058 trades; gross-negative −0.051R, i.e. it loses BEFORE fees too).
    // `assetchar` confirms crypto reversion is sub-fee at 1h. TSMOM is the book's only fee-clearing source, so the
    // engine now leans on momentum + the fee-to-risk filter (config.plan) rather than this mean-reverter.
    // Regime-gating: only fire each strategy in the regime where it has a MEASURED edge
    // (momentum → trend, mean-reversion → range; see `npm run regimeedge`). DEFAULT off:
    // `npm run regimegate` showed gating raises return (+88%→+135%) but ~doubles drawdown
    // (7%→12%) with ~equal risk-adjusted return — it's a return/risk lever, not a free win.
    // Turn on if you want the higher-return / higher-drawdown profile.
    regimeGate: false,
    emaFast: 20,
    emaSlow: 50,
    pullbackAtrMult: 0.5, // "near the EMA/level" = within this × ATR
    swingLookback: 20, // recent swing used for targets
    tsmomLookback: 48, // bars for the momentum lookback
    tsmomThresholdPct: 3, // |return| over lookback to count as momentum
    ofiLookback: 8, // bars for order-flow imbalance
    ofiThreshold: 0.15, // net aggressive imbalance (0..1) to trigger
    bbPeriod: 20, // Bollinger SMA period
    bbMult: 2, // Bollinger stdev multiplier
    // Broad-MARKET regime filter (opt-in, default off). The bot's edge is measured only in DOWNTRENDS
    // (`npm run regimealpha`: bull −9.8% / bear +8.9% / flat −9.7% avg per window; `npm run regimeoverlay`:
    // trading ONLY in trailing downtrends lifts the full-history account from +6.1%/31%DD to +31%/13.5%DD,
    // ret/DD 0.20→2.31, robust in 10/12 param cells). When true, the paper engine skips NEW entries unless
    // the equal-weight SOL/BTC/ETH basket's trailing `marketRegimeLookback`-bar return is below
    // −`marketRegimeBandPct`% (a causal downtrend). Big behavior change — the bot sits idle in bull/flat
    // markets (~⅔ of the time). Off = no effect. In-sample/one-path result; validate forward before trusting.
    marketRegimeFilter: true,
    marketRegimeLookback: 168, // trailing bars (~7 days @ 1h) for the market-regime signal
    marketRegimeBandPct: 3, // |trailing basket return| below this % = flat (neither bull nor bear)
    // Regime ENGINE mode (opt-in). "trail" = the measured 168-bar trailing-return classifier above (DEFAULT — it's
    // what every backtest validated). "er" = a faster Kaufman Efficiency-Ratio classifier over `erLookback` bars:
    // ER = |net move| / Σ|bar moves| ∈ [0,1] (≈1 clean trend, ≈0 chop); direction from the net move. ER is more
    // responsive but UNMEASURED here — leave "trail" until `deepbacktest`/`regimeoverlay` prove ER selects better.
    regimeMode: (process.env.REGIME_MODE ?? "trail") as "trail" | "er",
    erLookback: 24, // bars for the Efficiency-Ratio window (only used when regimeMode === "er")
    // The basket the regime signal is built from — kept CRYPTO-ONLY and decoupled from `watchlist`, so adding a
    // non-crypto asset (e.g. gold XAUT) to the watchlist for observation does NOT poison the crypto regime read.
    regimeSymbols: ["SOLUSDT", "BTCUSDT", "ETHUSDT"] as string[],
    // Multi-timeframe alignment gate — OPT-IN, default OFF. `npm run mtfedge` measured AND OOS-validated (early/late
    // split) that requiring a SHORT to agree with BOTH the 4h AND 1d trend lifts the short edge materially — aligned
    // shorts +0.31R vs +0.10R for all shorts in the recent (out-of-sample) half. When on, it adds that per-symbol
    // HTF-alignment requirement to the FILTERED account's entries (LONG needs 4h&1d up, SHORT needs 4h&1d down); the
    // raw `strategy` account is untouched. Off = no effect. The one return-lever to survive OOS scrutiny so far.
    mtfAlignFilter: true,
  },

  // ---- Regime detection (which market condition each symbol is in) ----
  regime: { volatileAtrPct: 2.5, trendSepPct: 0.4 },

  // ---- Liquidation feed (Binance force-order WebSocket) ----
  liquidation: { enabled: true, windowMs: 300_000, cascadeUsd: 1_000_000 },

  // ---- Native desktop notifications (priority-filtered) ----
  notify: { enabled: true, minGrade: "OK" as "OK" | "STRONG" },

  // ---- Weighted confluence — weight factors by their measured usefulness.
  // Reweighted from a 233-signal SOL/BTC/ETH audit: flow +21pp & fvg +16pp (kept high);
  // sweep -17pp (consistently negative across all 3 pairs) and structure inert (fired 3/167) → zeroed;
  // premium/discount low-info (present on 87%, -3pp) → halved; HTF unstable across runs → trimmed to 1. ----
  confluenceWeights: { rejection: 1, wall: 1.5, flow: 2, fvg: 1.5, sweep: 0, pd: 0.5, structure: 0, htf: 1 } as Record<string, number>,

  // ---- Broad-market regime gate — WHICH regimes the `filtered` account may open in ----
  market: {
    // The gate BLOCKS any regime NOT in this list (the master on/off is still config.strategies.marketRegimeFilter,
    // and the `strategy` account is never gated). 2026-07-15: flipped from bear-only → ["bull","flat"]. With the new
    // TSMOM-dominant, fee-filtered book the 2-year deepbacktest earns in BULL (+0.059R) and FLAT (+0.067R) and LOSES
    // in BEAR (−0.066R) — the inverse of the old S/R+reversion book. Set ["bull","flat","bear"] to pass ALL regimes
    // (gate effectively off); set ["bear"] to restore the old bear-only rule. CAVEAT: this split is in-sample (the
    // book fails OOS) — treat it as a forward-validating choice, not a proven rule.
    allowedRegimes: ["bull", "flat"] as ("bull" | "bear" | "flat")[],
  },

  // ---- Spoofing detection (watch for fake walls that get pulled) ----
  spoof: {
    enabled: true,
    bandPct: 0.5, // only consider walls within this % of price
    wallMult: 4, // a "wall" is at least this× the median level size in the band
    keepFrac: 0.4, // if a tracked wall shrinks below this fraction, it was pulled
  },

  // ---- Trade journal (persist signals, auto-evaluate outcomes) ----
  journal: {
    enabled: true,
    file: "data/journal.json",
    maxDashboard: 20, // how many recent entries to show on the dashboard
  },

  // ---- Trade plan (attached to touch/confirmation alerts) ----
  plan: {
    enabled: true,
    accountUsd: 1000, // your account size, for position sizing
    riskPct: 1, // % of the account risked per trade
    stopBufferPct: 0.3, // stop placed this % beyond the level
    minRR: 1.5, // plans below this risk:reward get flagged as low-quality
    // ---- Fee-to-risk filter (2026-07-15) — the real fee-drag fix. Reject a signal when the round-trip taker fee
    // eats more than `maxFeeThresholdPct` of the 1R stop distance. feePctOfRisk = (2·feeBps/1e4)·entry / |entry−stop|
    // ≈ the trade's fee-in-R. This prunes tight-stop / high-turnover setups (breakout-retest 0.16R, bollinger 0.13R
    // fee-in-R) that enrich the exchange, while keeping wide-stop TSMOM (0.029R). Measured via `npm run deepbacktest`.
    feeFilter: true, // ON — this is the requested fix; set false to restore the old take-everything behaviour
    maxFeeThresholdPct: 0.05, // reject if round-trip fee > 5% of the 1R distance (i.e. fee-in-R > 0.05)
    // ---- Efficiency-scaled position sizing (opt-in, DEFAULT OFF). RISK CONTROL, NOT a return lever: scaling risk
    // does NOT change per-trade R-expectancy — it only shrinks $ variance/drawdown in choppy regimes. When on AND
    // regimeMode==="er", riskPct scales linearly with the basket Efficiency Ratio between the floor (chop) and the
    // configured riskPct (clean trend). Leave OFF unless you specifically want a smoother equity curve, not more edge.
    riskScaleByEfficiency: false,
    riskPctFloor: 0.25, // % risk in max-noise (ER≈0) regimes; scales up to config.paper.riskPct at ER≈1
    // Confirmation entry. false = enter at the LEVEL (a limit) — but the rejection candle already
    // closed past it, so the paper account's fill is a MIRAGE (it books +2.93R that mostly never
    // fills). true = enter at the confirmation candle's CLOSE (a real market fill) — `npm run
    // confirmedge` measured that at an HONEST +0.158R. Flip to true for a trustworthy paper account
    // (confirmation R:R drops from ~11 to ~2-3, but the numbers become ones you'd actually get).
    confirmEntryAtClose: true,
  },

  // ---- Paper trading (fake-money account that auto-takes the signals) ----
  // The bot opens a simulated position on each signal, sizes it off the CURRENT
  // virtual balance (so it compounds), and books dollar P&L when stop/target hits.
  // This is the track record you use to decide whether to ever go live.
  paper: {
    enabled: true,
    file: "data/paper.json",
    startBalanceUsd: 1000, // fake money you start with
    // 2026-07-19 (USER REQUEST: "use high leverage… any risk amount but the liquidation shouldn't be closer").
    // Raised 1 → 5 (5× the per-trade risk). NB leverage here is DERIVED, not set: leverage ≈ riskPct / stopPct,
    // so 5% risk on a 2% stop ≈ 2.5×, on a 0.5% stop ≈ 10×. HONEST: risk sizing does NOT change R-expectancy — it
    // multiplies BOTH wins and losses. On this book (measured ≈0 to −0.07R/trade net of fees) it multiplies the
    // bleed and the drawdown; it cannot create edge. The `leverage` block below is what keeps liquidation away.
    riskPct: 5, // % of the current balance risked per trade
    // ---- Liquidation safety (2026-07-19) — implements "liquidation shouldn't be closer [than the stop]" ----
    // Higher leverage pulls the liquidation price toward entry; if it lands INSIDE the stop you get margin-called
    // before your stop ever fills. `leverageCappedSize` (paperexit.ts) therefore bounds leverage to
    //   L ≤ 1 / (liqSafetyMult · stopFrac + maintenanceMarginRate)
    // so liquidation always sits at least `liqSafetyMult`× the stop distance away; if the requested riskPct implies
    // more leverage than that, the SIZE is cut (the trade risks less than riskPct) instead of accepting a near liq.
    // The paper engine also now MODELS liquidation as a real exit — without it a high-leverage paper account would
    // show a smooth scaled curve and never simulate a margin call, i.e. it would LIE (see CLAUDE.md rule 6).
    leverage: {
      maxLeverage: 20, // absolute ceiling regardless of how tight the stop is
      maintenanceMarginRate: 0.005, // 0.5% — Binance-ish maintenance margin for majors at moderate size
      liqSafetyMult: 2, // liquidation must be ≥ 2× the stop distance from entry
    },
    feeBps: 5, // taker fee per side in basis points (Binance futures ≈ 0.05%)
    slippageBps: 2, // extra slippage on STOP fills (market exits fill worse than the level; targets are limits → no slippage)
    maxOpenPerSymbol: 1, // don't stack positions on the same symbol
    // Symbols the core_4h forward-test account OPENS new 4h trades on. 2026-07-17: focused to BTC/SOL — `rrsweep`
    // per-symbol showed the 4h edge lives in BTC (+0.118R OOS) and SOL, while ETH is a net drag (fails WF). Existing
    // ETH positions still manage out (core_4h keeps EVALUATING all regimeSymbols); it just won't open NEW ETH. NB:
    // this is post-hoc symbol selection — a hypothesis to forward-test, not proven. See EDGE-REPORT 2026-07-17.
    core4hSymbols: ["BTCUSDT", "SOLUSDT"] as string[],
    // Correlation cap: max concurrent SAME-direction positions across the (correlated)
    // watchlist. 0 = disabled; opposite-side positions aren't capped (they partially hedge).
    // DEFAULT 0 (off) — `npm run portfolio` MEASURED that capping HURT: when SOL/BTC/ETH fire
    // the same setup together it's usually a higher-conviction market-wide move worth full
    // participation, so capping skipped correlated winners (no-cap +84%/6.9%DD vs cap-2
    // +40%/16.4%DD in-sample). Kept as opt-in TAIL-insurance vs a correlated crash not in
    // that calm sample — set to 1 or 2 only if you want that protection at a measured cost.
    maxSameDirection: 0,
    minRR: 1, // skip signals whose reward:risk is below this
    takeStrategies: true, // paper-trade strategy setups
    takeConfirmations: true, // paper-trade S/R confirmation signals
    announce: true, // send open/close to terminal + Telegram
    maxDashboard: 15, // recent closed trades to keep for the dashboard
    // Exit management for OPEN positions. Backtest (469 trades): a LATE break-even at +2.5R is
    // ~EV-neutral-to-positive AND rescues "up big then round-tripped to stop" losses — EXCEPT for
    // runner strategies whose edge IS reaching the far target (breakout-retest), so those are
    // excluded. Early break-even (+1R) is a trap: it choked winners and HALVED the edge.
    exit: {
      breakevenAtR: 2.5, // once a trade is +this many R in profit, move its stop to break-even
      breakevenExclude: ["breakout-retest"] as string[], // these need room to run — no break-even (it halves their edge)
      trailAtrMult: 3, // after break-even, trail 3×ATR behind the peak. 2026-07-17 (user request): ON. `rrsweep`
      // measured trailing-3ATR as the ONLY net-positive exit on the 4h momentum book (+0.041R pooled OOS, WF-validated)
      // — momentum wants to let winners run. CAVEAT: this exit config is GLOBAL, so it also changes the 1h accounts,
      // where the older `exitedge` measured FIXED targets beating trailing — so it may HELP 4h and HURT 1h; watch both.
      // Partial take-profit — OPT-IN, default OFF. Measured (npm run exitedge, 2559 trades): banking half at
      // +1R and moving the rest to break-even lifts WIN-RATE 33%→50% and rescues the 38% of winners that ran
      // +1R then round-tripped to ≤0 — but it does NOT raise total return (~-0.01R/trade). A RISK / smoothness
      // lever, not a profit one. Turn on to lock give-backs; leave off to keep the marginally higher expectancy.
      partialTp: {
        enabled: true, // ON (user request): skim `fraction` off each trade at +atR, remainder to break-even
        atR: 1, // bank once the trade is +this many R in profit
        fraction: 0.5, // portion of the position to close (0.5 = half)
        exclude: ["breakout-retest"] as string[], // runners: let them reach target, don't skim the winner
      },
    },
    // ---- Maker / limit-entry forward-test (OPT-IN, default OFF) ----
    // Measured (`npm run makeredge`): entering via a resting LIMIT (maker fee ≈2bps) instead of a market order
    // (taker 5bps) is the ONE execution win with real evidence — it saves ~+0.009R/signal on the 4h book by paying
    // less fee on the same fills (the thin 4h gross edge is otherwise ~75% eaten by taker fees; see bookwalk fee
    // sweep + EDGE-REPORT 2026-07-18). BUT a maker fill is NOT guaranteed — a limit only fills if price trades back
    // to it — so booking the cheaper fee on a guaranteed fill would be a LIE (the same mirage the confirmEntryAtClose
    // fix already killed). When enabled, this spins up a NEW parallel account `core_4h_maker` that rests a limit at
    // each 4h signal's entry and OPENS only if a later 4h candle trades through it (else CANCELS) — an honest
    // forward-test run ALONGSIDE the market-entry `core_4h`, so the two live records compare maker-vs-market directly.
    // DEFAULT OFF = the account does not exist and nothing changes. Run with env MAKER_ENTRY=on to start the forward-test.
    // Conservative by design: only the ENTRY leg gets the maker rate; exits (and partials/break-even) stay taker, so
    // the account UNDER-states the maker benefit rather than over-stating it. Does NOT touch core_4h or any 1h account.
    makerEntry: {
      enabled: process.env.MAKER_ENTRY === "on", // OPT-IN via env — shipped default OFF; run with MAKER_ENTRY=on to start the forward-test
      feeBps: 2, // maker fee per side (Binance USDⓈ-M maker ≈ 2bps; lower with BNB/VIP tiers)
      fillWindowBars: 4, // cancel a resting limit not touched within this many of the account's (4h) candles
    },
    // ---- Circuit-breaker (OPT-IN, default OFF) ----
    // When enabled, PAUSES new entries on the listed account(s) while a risk rail is tripped — the same three
    // rails the live shadow (`live.ts`) already runs: daily-loss, consecutive-loss, and drawdown. Open trades
    // keep managing/closing normally; only NEW entries pause. DEFAULT OFF = zero behaviour change: today's
    // paper accounts trade straight through streaks and drawdowns (unlike the live shadow, which halts), so the
    // paper record slightly OVERSTATES tail resilience vs an account we'd actually run. Turning this on makes
    // paper behave like live and lets the two-account experiment test the breakers empirically.
    // SELF-RESETTING (so a paper account never latches off forever): the daily halt clears at UTC midnight; the
    // streak / drawdown halts clear once `cooldownHours` pass with no new close (then one "probe" entry is
    // allowed). MEASURED effect of turning it on: `npm run disciplineedge` (see EDGE-REPORT.md).
    discipline: {
      enabled: true, // ON (2026-07-15) — but scoped to core_4h ONLY (see applyTo); the 1h accounts are untouched.
      applyTo: ["core_4h"] as string[], // ONLY the fragile 4h forward-test account; filtered/strategy are NOT gated.
      maxDailyLossUsd: 0, // OFF — architect specified streak + drawdown only.
      maxConsecutiveLosses: 4, // pause core_4h after 4 losses in a row.
      maxDrawdownPct: 5, // pause core_4h at 5% drawdown from its equity high-water mark.
      // NB: `npm run disciplineedge` MEASURED the drawdown rail can HURT an edge book (it's reactive — pauses the
      // recovery). On core_4h (a marginal book) it will trip often; that's acceptable here — the point is to
      // exercise the breaker + LLM-audit trigger on a live forward-test, not to maximise this account's return.
      cooldownHours: 24, // streak/drawdown pause lasts 24h after the last close, then a probe entry is allowed.
    },
    // ---- News / volatility guards (OPT-IN, default OFF) ----
    // The bot is otherwise NEWS-BLIND — on a CPI/FOMC/NFP release it mistakes the spike for a breakout and
    // walks into the whipsaw. These pause NEW entries during (a) abnormal volatility spikes and (b) scheduled
    // macro windows. HONEST: they CUT news-driven losses; they do NOT create an edge (the book fails OOS
    // regardless — see EDGE-REPORT). Measured effect of the vol gate: `npm run bookwalk` (VOL FILTER block).
    volFilter: {
      enabled: false, // pause new entries when the latest candle's range is an abnormal spike (a news proxy — no external data)
      atrLookback: 14, // bars for the baseline ATR
      spikeMult: 2.0, // spike = current candle range > this × trailing ATR
    },
    newsBlackout: {
      enabled: false, // pause new entries inside scheduled macro-event windows. NO live feed — you set the windows.
      // Recurring daily UTC windows — the default covers the US 8:30-ET data slot (CPI/NFP/PPI/jobless ≈ 12:30 UTC).
      dailyWindowsUtc: [{ start: "12:00", end: "13:30" }] as { start: string; end: string }[],
      weekdaysOnly: true, // US macro data is weekday-only (crypto trades weekends, but the data doesn't drop then)
      events: [] as { from: string; to: string }[], // one-off ISO windows for FOMC etc., e.g. {from:"2026-07-30T18:00:00Z",to:"2026-07-30T19:00:00Z"}
    },
  },

  // ---- LIVE trading (see LIVE-TRADING-SPEC.md) ----
  // STAGE 1 = DRY-RUN SHADOW ONLY. When enabled, `live.ts` mirrors the `filtered` paper account's
  // decisions and LOGS the exact order it WOULD place — it submits NOTHING and touches no API keys.
  // Two switches are required to even run the shadow: `enabled: true` here AND env `LIVE_TRADING=on`.
  // There is deliberately NO code that places a real order yet (that is Stage 2+, gated on the spec).
  live: {
    enabled: false, // AND env LIVE_TRADING must be 'on'
    account: "filtered" as "filtered" | "strategy", // mirror ONLY the bear-only account
    maxConcurrent: 2, // max simultaneous live positions the rails would allow
    maxPositionUsd: 50, // per-position notional cap ($) — start tiny
    maxDailyLossUsd: 25, // halt new entries once the day's shadow P&L drops below -this
    maxDrawdownPct: 10, // halt + (in live) disarm at this drawdown from the shadow peak
    maxConsecutiveLosses: 4, // halt new entries after this many losses in a row
    maxLeverage: 3, // hard leverage cap (margin = notional / this)
    slippageGuardBps: 15, // (Stage 2) reject market fills worse than this
    priceSanityBps: 50, // (Stage 2) reject entries this far from mark
    autoDisarmHours: 8, // (Stage 2) armed state auto-expires
    deadmanSeconds: 30, // (Stage 2) halt if exchange link drops longer than this
    flattenOnKill: true, // (Stage 2) kill switch also closes open positions
  },

  // ---- Local dashboard (live web view, first step toward the desktop app) ----
  dashboard: {
    enabled: true,
    port: Number(process.env.PORT) || 1000, // ← YOUR dashboard port. Change this ONE number to anything you want. Opens at http://localhost:1000
  },

  // ---- Backtest (npm run backtest / deepbacktest) ----
  backtest: {
    historyCandles: 1000, // how much history to replay (max 1500)
    horizon: 12, // candles after a signal to judge the outcome
    targetPct: 1.5, // move IN FAVOR by this % = a win
    stopPct: 1.0, // move AGAINST by this % = a loss
    outFile: "data/backtest.json",
    // Timeframes `npm run deepbacktest` sweeps SEQUENTIALLY. Each runs the full book + a 70/30 OOS split; results
    // print side-by-side. Strategy detectors are bar-count based, so they run NATIVELY on each TF's candles (that IS
    // the timeframe test — rescaling their periods would just resample the 1h strategy); only the wall-clock regime
    // lookback scales per TF. Higher TF ⇒ wider %-stops ⇒ lower fee-per-R (the effect under test). Env DEEP_TF="1h,4h,12h".
    timeframes: ["1h", "4h", "12h"] as string[],
  },
  // Print a live status line every poll so you can see it's working.
  printStatus: true,

  // ---- Telegram (optional; terminal alerts work without it) ----
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
} as const;

/**
 * A secret-free snapshot of the operating config for the dashboard's Configuration
 * panel. ALLOWLIST ONLY — never include telegram.token / chatId or any credential.
 */
export function configSummary() {
  const enabledStrategies = Object.entries(config.strategies)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return {
    market: {
      watchlist: config.watchlist,
      interval: config.interval,
      primary: config.symbol,
      levelMode: config.levelMode,
      manualResistance: config.levelMode === "manual" ? config.manualResistance : null,
      manualSupport: config.levelMode === "manual" ? config.manualSupport : null,
      pollIntervalSec: config.pollIntervalSec,
    },
    account: {
      startBalanceUsd: config.paper.startBalanceUsd,
      riskPct: config.paper.riskPct,
      feeBps: config.paper.feeBps,
      slippageBps: config.paper.slippageBps,
      maxOpenPerSymbol: config.paper.maxOpenPerSymbol,
      minRR: config.paper.minRR,
    },
    exit: {
      breakevenAtR: config.paper.exit.breakevenAtR,
      breakevenExclude: config.paper.exit.breakevenExclude,
      trailAtrMult: config.paper.exit.trailAtrMult,
    },
    consolidation: {
      lookback: config.lookback,
      maxRangeWidthPct: config.maxRangeWidthPct,
      minRangeWidthPct: config.minRangeWidthPct,
      touchTolerancePct: config.touchTolerancePct,
    },
    strategies: enabledStrategies,
    confluenceWeights: config.confluenceWeights,
    notifyMinGrade: config.notify.minGrade,
    telegramConfigured: Boolean(config.telegram.token && config.telegram.chatId),
  };
}
