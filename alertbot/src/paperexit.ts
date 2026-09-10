/**
 * Pure helpers for the paper engine, extracted from paper.ts so the money-path
 * logic is unit-testable without the file I/O the rest of paper.ts does.
 */

/**
 * Exit decision for one candle. Given a position's CURRENT stop/target (already
 * trailed if applicable) and a candle's low/high, decide whether it exits and at
 * what fill price. Rules (must stay identical to how paperEvaluate uses it):
 *   • STOP is checked before TARGET, so a candle whose range spans both resolves as
 *     a stop — conservative, since we can't know the intra-candle path.
 *   • Stop exits are market fills → worse by `slip` (LONG fills below, SHORT above).
 *   • Target exits are limit orders → fill exactly at the level, no slippage.
 */
export function resolveExit(
  long: boolean,
  stop: number,
  target: number,
  low: number,
  high: number,
  slip: number,
): { exit: number; reason: "target" | "stop" } | null {
  if (long) {
    if (low <= stop) return { exit: stop * (1 - slip), reason: "stop" };
    if (high >= target) return { exit: target, reason: "target" };
  } else {
    if (high >= stop) return { exit: stop * (1 + slip), reason: "stop" };
    if (low <= target) return { exit: target, reason: "target" };
  }
  return null;
}

/**
 * Correlation risk guard. The watchlist is crypto majors (SOL/ETH/BTC) which move
 * ~together, so N open positions in the SAME direction is really one N-sized
 * directional bet, not N independent trades. Returns true if opening another `dir`
 * position would exceed `cap` concurrent same-direction positions. (Opposite-side
 * positions across correlated symbols partially hedge, so only same-direction is
 * capped.) `cap <= 0` disables the guard.
 */
export function correlatedCapReached(open: { direction: "LONG" | "SHORT" }[], dir: "LONG" | "SHORT", cap: number): boolean {
  if (cap <= 0) return false;
  return open.filter((p) => p.direction === dir).length >= cap;
}

/**
 * Broad-market regime gate for the `filtered` paper account (see config.market.allowedRegimes). BLOCKS a new entry
 * whenever the current regime is NOT in `allowedRegimes`. 2026-07-15: default allowed set is ["bull","flat"] —
 * the TSMOM-dominant book earns in bull/flat and loses in bear (the inverse of the old bear-only rule; see
 * EDGE-REPORT). `filterOn` false, an unknown regime (null), or an all-inclusive `allowedRegimes` never blocks.
 * Pure so it can be unit-tested away from the engine.
 */
export function marketRegimeBlocks(
  filterOn: boolean,
  regime: "bull" | "bear" | "flat" | null,
  allowedRegimes: ("bull" | "bear" | "flat")[],
): boolean {
  if (!filterOn || regime === null) return false;
  return !allowedRegimes.includes(regime);
}

/**
 * Opt-in multi-timeframe alignment gate (see config.strategies.mtfAlignFilter). Blocks an entry unless the trade
 * direction agrees with BOTH the 4h and 1d trend (LONG needs both up, SHORT needs both down). Measured AND
 * OOS-validated (`npm run mtfedge`) to lift the short edge. Unknown/missing HTF data never blocks. Pure.
 */
export function mtfAlignBlocks(filterOn: boolean, direction: "LONG" | "SHORT", mtf: { tf: string; dir: string }[] | undefined): boolean {
  if (!filterOn || !mtf) return false;
  const d4 = mtf.find((m) => m.tf === "4h")?.dir;
  const d1 = mtf.find((m) => m.tf === "1d")?.dir;
  if (!d4 || !d1) return false; // unknown higher-timeframe trend → don't block
  const want = direction === "LONG" ? "up" : "down";
  return !(d4 === want && d1 === want);
}

/**
 * Opt-in VOLATILITY-SPIKE gate (config.paper.volFilter, default OFF). A cheap, external-data-free proxy for
 * "news is happening": when the latest candle's range blows past the trailing ATR, the market is convulsing
 * (CPI/FOMC/NFP etc.) — a bad time to trust a breakout/momentum entry. Pure so it's unit-testable. `enabled`
 * false, or a non-positive ATR/mult, never blocks.
 */
export function volSpikeBlocks(enabled: boolean, candleRange: number, atr: number, mult: number): boolean {
  return enabled && atr > 0 && mult > 0 && candleRange > mult * atr;
}

/**
 * Fee-to-risk gate (config.plan.feeFilter, default ON as of 2026-07-15). The 2-year deepbacktest showed the book's
 * gross edge (+0.009R) is swamped by fees (~0.11R/trade) — because tight-stop setups pay a huge fee-per-R. This
 * rejects a signal when the round-trip taker fee consumes more than `maxPct` of the 1R stop distance:
 *   feePctOfRisk = roundTripFeeRate · entry / |entry − stop|   (≈ the trade's fee-in-R)
 * `roundTripFeeRate` = 2 · feeBps/1e4 (both legs). Pure so it's unit-tested away from the engine. Non-positive
 * risk or a non-positive threshold never blocks. Keeps wide-stop momentum (low fee-per-R), prunes churny scalps.
 */
export function feeBlocksTrade(entry: number, stop: number, roundTripFeeRate: number, maxPct: number): boolean {
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || maxPct <= 0 || roundTripFeeRate <= 0) return false;
  const feePctOfRisk = (roundTripFeeRate * entry) / risk;
  return feePctOfRisk > maxPct;
}

/**
 * Honest maker/limit-entry fill test (config.paper.makerEntry, default OFF). A resting BUY limit (LONG) fills only
 * when price trades DOWN to it (a bar low ≤ limit); a resting SELL limit (SHORT) fills only when price trades UP to
 * it (a bar high ≥ limit). This is what keeps a maker paper account honest: it books the cheaper maker fee ONLY when
 * a limit would actually have filled, and cancels the signal otherwise (see paper.ts pending-limit handling). Pure.
 */
export function limitTouched(direction: "LONG" | "SHORT", limit: number, low: number, high: number): boolean {
  return direction === "LONG" ? low <= limit : high >= limit;
}

export interface LeverageCaps {
  maxLeverage: number; // absolute ceiling (exchange/config limit)
  maintenanceMarginRate: number; // e.g. 0.005 = 0.5% maintenance margin
  liqSafetyMult: number; // liquidation must sit at least this × the stop distance away (>1 = buffer)
}

/**
 * Liquidation price for an ISOLATED-margin futures position. At leverage L the position is liquidated once the
 * adverse move eats the initial margin down to maintenance: distance ≈ (1/L − mmr) as a fraction of entry.
 * Pure. `lev <= 0` → no liquidation (returns an unreachable price).
 */
export function liquidationPrice(long: boolean, entry: number, lev: number, mmr: number): number {
  if (lev <= 0 || !Number.isFinite(lev)) return long ? 0 : Number.POSITIVE_INFINITY;
  const dist = Math.max(0, 1 / lev - mmr); // fraction of entry price
  return long ? entry * (1 - dist) : entry * (1 + dist);
}

/**
 * LIQUIDATION-AWARE SIZING (user requirement: "any risk amount, but liquidation shouldn't be closer").
 *
 * Risk-based sizing sets size = riskUsd / stopDistance, so leverage = notional/equity is DERIVED — and the higher
 * it goes, the CLOSER liquidation sits to entry. Getting liquidated before your stop fills is the failure mode this
 * prevents: we require liquidation to sit at least `liqSafetyMult` × the stop distance away, which bounds leverage to
 *      L ≤ 1 / (liqSafetyMult · stopFrac + mmr)
 * and also respect an absolute `maxLeverage`. If the requested risk implies more leverage than that, the SIZE is cut
 * (so the trade risks less than the configured riskPct) rather than accepting a near liquidation. Pure + unit-tested.
 */
export function leverageCappedSize(
  entry: number,
  stopDist: number,
  equity: number,
  desiredUnits: number,
  caps: LeverageCaps,
): { units: number; leverage: number; capped: boolean; maxLeverage: number } {
  if (entry <= 0 || stopDist <= 0 || equity <= 0 || desiredUnits <= 0) return { units: 0, leverage: 0, capped: false, maxLeverage: 0 };
  const stopFrac = stopDist / entry;
  const mmr = Math.max(0, caps.maintenanceMarginRate);
  const safety = Math.max(1, caps.liqSafetyMult);
  // Leverage at which liquidation would sit exactly `safety`× the stop distance away.
  const levFromLiq = 1 / (safety * stopFrac + mmr);
  const allowed = Math.max(0, Math.min(caps.maxLeverage > 0 ? caps.maxLeverage : levFromLiq, levFromLiq));
  const desiredLev = (desiredUnits * entry) / equity;
  if (desiredLev <= allowed) return { units: desiredUnits, leverage: desiredLev, capped: false, maxLeverage: allowed };
  const units = (allowed * equity) / entry;
  return { units, leverage: allowed, capped: true, maxLeverage: allowed };
}

export interface NewsBlackoutCaps {
  enabled: boolean;
  dailyWindowsUtc: { start: string; end: string }[]; // "HH:MM" UTC recurring windows
  weekdaysOnly: boolean; // apply the daily windows only Mon–Fri (US macro data is weekday-only)
  events: { from: string; to: string }[]; // one-off ISO datetime windows (FOMC etc.)
}

/**
 * Opt-in NEWS-BLACKOUT gate (config.paper.newsBlackout, default OFF). Schedule-driven (NO live feed — you set
 * the windows), so it's deterministic and testable. Blocks if `nowMs` falls inside a recurring daily UTC
 * window (skipped on weekends when weekdaysOnly) OR any one-off event window. Pure. `enabled` false never blocks.
 */
export function inNewsBlackout(nowMs: number, caps: NewsBlackoutCaps): boolean {
  if (!caps.enabled) return false;
  const d = new Date(nowMs);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const weekend = dow === 0 || dow === 6;
  if (!(caps.weekdaysOnly && weekend)) {
    const hm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
    for (const w of caps.dailyWindowsUtc) { if (hm >= toMin(w.start) && hm < toMin(w.end)) return true; }
  }
  for (const e of caps.events) {
    const f = Date.parse(e.from), t = Date.parse(e.to);
    if (Number.isFinite(f) && Number.isFinite(t) && nowMs >= f && nowMs < t) return true;
  }
  return false;
}

export interface DisciplineCaps {
  enabled: boolean;
  applyTo: string[];
  maxDailyLossUsd: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  cooldownHours: number;
}

/**
 * Opt-in circuit-breaker gate for the paper engine (config.paper.discipline, DEFAULT OFF). Given an account's
 * closed-trade history (newest-first, as `acc.closed` is), current realized balance, and its equity high-water
 * mark, returns a block REASON if a risk rail is tripped, else null. Mirrors the live shadow's three rails but
 * SELF-RESETS so a paper account never latches off forever (a fully-halted account can never win its way out):
 *   • daily-loss  — today's (UTC) realized P&L ≤ -cap → blocked for the rest of the UTC day (clears at midnight).
 *   • streak      — ≥ cap consecutive losses AND the last close was < cooldownHours ago → blocked; after
 *                   cooldownHours of no new close the pause lifts and one probe entry is allowed.
 *   • drawdown    — ≥ cap% below the equity high-water mark AND within the same cooldown window → blocked.
 * Pure (no I/O), so the money path stays unit-testable. `enabled` false → never blocks. Each `cap` of 0 = that
 * rail off. `nowMs` is passed in (not read from the clock) so tests are deterministic.
 */
export function disciplineBlocks(
  closedNewestFirst: { pnlUsd: number; closeTime: string }[],
  balance: number,
  peakBalance: number,
  caps: DisciplineCaps,
  nowMs: number,
): string | null {
  if (!caps.enabled) return null;
  // 1) Daily loss — UTC day, resets at midnight (no cooldown: hitting the day's limit stops you for the day).
  if (caps.maxDailyLossUsd > 0) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const todayPnl = closedNewestFirst.filter((t) => t.closeTime.slice(0, 10) === day).reduce((s, t) => s + t.pnlUsd, 0);
    if (todayPnl <= -caps.maxDailyLossUsd) return `daily-loss halt (today $${todayPnl.toFixed(2)} ≤ -$${caps.maxDailyLossUsd})`;
  }
  // Streak & drawdown only hold for a cooldown window after the last close — otherwise a paused account latches
  // off forever (it can never close a winner to reset while it's blocked). After the window, a probe is allowed.
  const lastCloseMs = closedNewestFirst.length ? Date.parse(closedNewestFirst[0]!.closeTime) : 0;
  const inCooldown = lastCloseMs > 0 && nowMs - lastCloseMs < caps.cooldownHours * 3_600_000;
  if (inCooldown) {
    if (caps.maxConsecutiveLosses > 0) {
      let streak = 0;
      for (const t of closedNewestFirst) { if (t.pnlUsd <= 0) streak++; else break; }
      if (streak >= caps.maxConsecutiveLosses) return `${streak}-loss streak halt (cooldown ${caps.cooldownHours}h)`;
    }
    if (caps.maxDrawdownPct > 0 && peakBalance > 0) {
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd >= caps.maxDrawdownPct) return `drawdown halt (${dd.toFixed(1)}% ≥ ${caps.maxDrawdownPct}%, cooldown ${caps.cooldownHours}h)`;
    }
  }
  return null;
}

/**
 * Partial take-profit math (opt-in exit management). Banks `fraction` of the position at the +`atR` level
 * (a resting limit → fills AT the level; taker fee applied for conservatism) and returns the fee-aware
 * break-even stop for the remainder. Pure, so the money path stays unit-testable.
 */
export function partialFill(
  long: boolean,
  entry: number,
  riskDist: number,
  atR: number,
  fraction: number,
  sizeUnits: number,
  feeRate: number,
): { level: number; partSize: number; partialPnl: number; beStop: number; remaining: number } {
  const level = long ? entry + atR * riskDist : entry - atR * riskDist;
  const partSize = sizeUnits * fraction;
  const fees = feeRate * partSize * (entry + level);
  const sign = long ? 1 : -1;
  const partialPnl = sign * (level - entry) * partSize - fees;
  const feeBuf = feeRate * 2 * entry;
  const beStop = long ? entry + feeBuf : entry - feeBuf;
  return { level, partSize, partialPnl, beStop, remaining: sizeUnits - partSize };
}

/** Realized P&L for closing `closedUnits` of a position at `price` (fees on both
 *  legs of the closed units). Pure + linear in units, so partial + remainder of a
 *  position always decomposes to the same total as closing it whole at one price —
 *  the invariant that keeps a manual partial close honest. Used by paperClose. */
export function partialClosePnl(
  direction: "LONG" | "SHORT",
  entry: number,
  price: number,
  closedUnits: number,
  feeRate: number,
): number {
  const sign = direction === "LONG" ? 1 : -1;
  return sign * (price - entry) * closedUnits - feeRate * closedUnits * (entry + price);
}
