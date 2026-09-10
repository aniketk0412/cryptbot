import { config } from "./config.js";
import { pivotHighs, pivotLows } from "./indicators.js";
import type { Candle, Level, Range, TradePlan } from "./types.js";

/** Build a plan + position sizing from explicit entry/stop/target. */
export function planFrom(direction: "LONG" | "SHORT", entry: number, stop: number, target: number): TradePlan {
  const c = config.plan;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const riskUsd = (c.accountUsd * c.riskPct) / 100;
  const sizeUnits = risk > 0 ? riskUsd / risk : 0;
  const notionalUsd = sizeUnits * entry;
  const leverage = c.accountUsd > 0 ? notionalUsd / c.accountUsd : 0;
  const sign = direction === "LONG" ? 1 : -1;
  const tp1 = entry + sign * risk;
  const tp2 = entry + sign * 2 * risk;
  const tp3 = entry + sign * 3 * risk;
  // Fee-to-risk transparency (the fee-drag fix): round-trip taker fee as a fraction of the 1R stop distance.
  // feePctOfRisk ≈ the trade's fee-in-R; feeHeavy flags the ones the config.plan.feeFilter gate would reject.
  const roundTripFeeRate = (2 * config.paper.feeBps) / 10000;
  const feePctOfRisk = risk > 0 ? (roundTripFeeRate * entry) / risk : Infinity;
  const feeHeavy = c.feeFilter && feePctOfRisk > c.maxFeeThresholdPct;
  return { direction, entry, stop, target, tp1, tp2, tp3, rr, riskUsd, sizeUnits, notionalUsd, leverage, lowQuality: rr < c.minRR, feePctOfRisk, feeHeavy };
}

/**
 * Build a range-trade plan for a level:
 *   support  → LONG  (enter at support, stop below it, target = resistance)
 *   resistance → SHORT (enter at resistance, stop above it, target = support)
 * Position size comes from account size × risk% ÷ (entry−stop distance).
 */
export function buildPlan(level: Level, range: Range): TradePlan {
  const buf = config.plan.stopBufferPct / 100;
  if (level === "support") return planFrom("LONG", range.low, range.low * (1 - buf), range.high);
  return planFrom("SHORT", range.high, range.high * (1 + buf), range.low);
}

/**
 * Confirmation plan — same stop/target as buildPlan, but the ENTRY depends on `atClose`
 * (config.plan.confirmEntryAtClose):
 *   • false → entry at the LEVEL (a limit; what the paper account books, but the fill is a mirage
 *     — the rejection candle already closed past it, so the order mostly never fills).
 *   • true → entry at the confirmation candle's CLOSE (a real market fill). `npm run confirmedge`
 *     measured the close model at an honest +0.147R vs the level model's mirage +2.89R.
 */
export function buildConfirmPlan(level: Level, range: Range, closePrice: number, atClose: boolean): TradePlan {
  const buf = config.plan.stopBufferPct / 100;
  if (level === "support") return planFrom("LONG", atClose ? closePrice : range.low, range.low * (1 - buf), range.high);
  return planFrom("SHORT", atClose ? closePrice : range.high, range.high * (1 + buf), range.low);
}

/** Merge near-duplicate levels (within ~0.15%) so TP1/TP2/TP3 are distinct S/R zones, not the same wick twice. */
function dedupeLevels(levels: number[]): number[] {
  const out: number[] = [];
  for (const v of levels) if (!out.some((u) => Math.abs(u - v) / (v || 1) < 0.0015)) out.push(v);
  return out;
}

/**
 * Structural take-profit levels beyond entry, nearest first: swing-pivot RESISTANCES above entry (LONG) or
 * SUPPORTS below entry (SHORT). Empty if there isn't enough history or no level lies in that direction.
 */
export function structureLevels(direction: "LONG" | "SHORT", entry: number, closed: Candle[], n = 3): number[] {
  if (closed.length < 15) return [];
  if (direction === "LONG") {
    const highs = closed.map((c) => c.high);
    const piv = pivotHighs(highs, 3, 3).map((i) => highs[i]!);
    return dedupeLevels(piv.filter((v) => v > entry * 1.0005).sort((a, b) => a - b)).slice(0, n);
  }
  const lows = closed.map((c) => c.low);
  const piv = pivotLows(lows, 3, 3).map((i) => lows[i]!);
  return dedupeLevels(piv.filter((v) => v < entry * 0.9995).sort((a, b) => b - a)).slice(0, n);
}

/**
 * Overlay STRUCTURAL take-profits onto a plan: TP1 = nearest resistance (LONG) / support (SHORT), TP2 = the
 * next level out, TP3 = the one after — the user's "scalp to the nearest level, then the next." Missing slots
 * extrapolate by the trade's risk so the TPs stay ordered; with NO structure in that direction we keep the
 * plan's R-multiple TPs. Display/plan only — the paper engine still exits at its measured `target` (a structural
 * TRAILING exit is a separate, measured change).
 */
export function applyStructureTps(plan: TradePlan, closed: Candle[]): TradePlan {
  const lv = structureLevels(plan.direction, plan.entry, closed, 3);
  if (!lv.length) return plan;
  const sign = plan.direction === "LONG" ? 1 : -1;
  const risk = Math.abs(plan.entry - plan.stop) || Math.abs(plan.tp1 - plan.entry) || plan.entry * 0.005;
  const tp1 = lv[0]!;
  const tp2 = lv[1] ?? tp1 + sign * risk;
  const tp3 = lv[2] ?? tp2 + sign * risk;
  return { ...plan, tp1, tp2, tp3 };
}
