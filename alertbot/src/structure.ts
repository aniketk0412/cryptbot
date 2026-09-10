import { config } from "./config.js";
import type { Candle, ConfluenceFactor, Level } from "./types.js";

const closedOnly = (candles: Candle[]) => candles.filter((c) => c.closed);

// ---------------------------------------------------------------------------
// Fair Value Gaps (FVG) + Inverse FVG (IFVG)
// ---------------------------------------------------------------------------

export interface FVG {
  type: "bull" | "bear";
  top: number;
  bottom: number;
  filled: boolean; // price traded fully back through the gap
  inverted: boolean; // price CLOSED through it → flips role (IFVG)
}

/**
 * A fair value gap is a 3-candle imbalance:
 *   bullish: candle3.low > candle1.high  (unfilled area below → acts as support)
 *   bearish: candle1.low > candle3.high  (unfilled area above → acts as resistance)
 * Later candles mark each gap filled/inverted.
 */
export function findFVGs(candles: Candle[]): FVG[] {
  const c = closedOnly(candles);
  const out: FVG[] = [];
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2]!;
    const z = c[i]!;
    if (z.low > a.high) out.push(mark({ type: "bull", top: z.low, bottom: a.high, filled: false, inverted: false }, c, i));
    if (a.low > z.high) out.push(mark({ type: "bear", top: a.low, bottom: z.high, filled: false, inverted: false }, c, i));
  }
  return out;
}

function mark(fvg: FVG, c: Candle[], from: number): FVG {
  for (let j = from + 1; j < c.length; j++) {
    const k = c[j]!;
    if (fvg.type === "bull") {
      if (k.low <= fvg.bottom) fvg.filled = true;
      if (k.close < fvg.bottom) fvg.inverted = true;
    } else {
      if (k.high >= fvg.top) fvg.filled = true;
      if (k.close > fvg.top) fvg.inverted = true;
    }
  }
  return fvg;
}

/** Factor: does an unfilled FVG (or a flipped IFVG) sit at the level, on the right side? */
export function fvgFactor(level: Level, price: number, candles: Candle[]): ConfluenceFactor {
  const band = price * (config.structure.fvgBandPct / 100);
  const nearZone = (f: FVG) =>
    Math.abs(f.top - price) <= band || Math.abs(f.bottom - price) <= band || (price <= f.top && price >= f.bottom);

  for (const f of findFVGs(candles)) {
    if (!nearZone(f)) continue;
    if (level === "support" && ((f.type === "bull" && !f.filled) || (f.type === "bear" && f.inverted))) {
      return { ok: true, label: f.inverted ? "IFVG support" : "bull FVG" };
    }
    if (level === "resistance" && ((f.type === "bear" && !f.filled) || (f.type === "bull" && f.inverted))) {
      return { ok: true, label: f.inverted ? "IFVG resistance" : "bear FVG" };
    }
  }
  return { ok: false, label: "no FVG" };
}

// ---------------------------------------------------------------------------
// Liquidity sweep (stop-hunt): wick beyond a prior swing, close back inside
// ---------------------------------------------------------------------------

export function sweepFactor(level: Level, candles: Candle[]): ConfluenceFactor {
  const c = closedOnly(candles);
  const n = config.structure.sweepLookback;
  if (c.length < n + 1) return { ok: false, label: "sweep n/a" };
  const last = c[c.length - 1]!;
  const prior = c.slice(-(n + 1), -1);

  if (level === "support") {
    const priorLow = Math.min(...prior.map((x) => x.low));
    const ok = last.low < priorLow && last.close > priorLow; // swept sell-side, closed back up
    return { ok, label: ok ? "swept sell-side" : "no sweep" };
  }
  const priorHigh = Math.max(...prior.map((x) => x.high));
  const ok = last.high > priorHigh && last.close < priorHigh; // swept buy-side, closed back down
  return { ok, label: ok ? "swept buy-side" : "no sweep" };
}

// ---------------------------------------------------------------------------
// Premium / Discount (equilibrium): are you buying cheap / selling expensive?
// ---------------------------------------------------------------------------

export function premiumDiscountFactor(level: Level, price: number, candles: Candle[]): ConfluenceFactor {
  const w = closedOnly(candles).slice(-config.structure.pdLookback);
  if (w.length === 0) return { ok: false, label: "P/D n/a" };
  const hi = Math.max(...w.map((c) => c.high));
  const lo = Math.min(...w.map((c) => c.low));
  const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5; // 0 = bottom, 1 = top
  const zone = pos < 0.5 ? "discount" : "premium";
  const ok = level === "support" ? pos < 0.5 : pos > 0.5;
  return { ok, label: `${(pos * 100).toFixed(0)}% ${zone}` };
}

// ---------------------------------------------------------------------------
// Market structure (simplified BOS/CHoCH trend read)
// ---------------------------------------------------------------------------

export function structureFactor(level: Level, candles: Candle[]): ConfluenceFactor {
  const w = closedOnly(candles).slice(-config.structure.structureLookback);
  if (w.length < 6) return { ok: false, label: "structure n/a" };
  const half = Math.floor(w.length / 2);
  const a = w.slice(0, half);
  const b = w.slice(half);
  const aHi = Math.max(...a.map((c) => c.high));
  const bHi = Math.max(...b.map((c) => c.high));
  const aLo = Math.min(...a.map((c) => c.low));
  const bLo = Math.min(...b.map((c) => c.low));
  const bull = bHi > aHi && bLo > aLo; // higher highs & higher lows
  const bear = bHi < aHi && bLo < aLo; // lower highs & lower lows
  const trend = bull ? "bullish" : bear ? "bearish" : "ranging";
  const ok = level === "support" ? bull : bear;
  return { ok, label: `structure ${trend}` };
}
