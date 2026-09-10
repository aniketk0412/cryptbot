import { config } from "./config.js";
import { atr, emaLast } from "./indicators.js";
import type { Candle } from "./types.js";

export type Regime = "uptrend" | "downtrend" | "ranging" | "volatile";

/**
 * Classify market condition from EMA separation (trend) and ATR (volatility).
 * Lets the dashboard show which strategy fits: trends → pullbacks, ranges →
 * fades, volatile → be careful.
 */
export function detectRegime(closed: Candle[]): { regime: Regime; note: string } {
  if (closed.length < config.strategies.emaSlow) return { regime: "ranging", note: "warming up" };
  const closes = closed.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const fast = emaLast(closes, config.strategies.emaFast);
  const slow = emaLast(closes, config.strategies.emaSlow);
  const a = atr(closed);
  const atrPct = (a / price) * 100;
  const sep = ((fast - slow) / price) * 100;

  let regime: Regime;
  if (atrPct > config.regime.volatileAtrPct) regime = "volatile";
  else if (sep > config.regime.trendSepPct) regime = "uptrend";
  else if (sep < -config.regime.trendSepPct) regime = "downtrend";
  else regime = "ranging";

  return { regime, note: `ATR ${atrPct.toFixed(1)}% · EMA sep ${sep >= 0 ? "+" : ""}${sep.toFixed(2)}%` };
}

/** Coarse regime class a strategy can be gated on: up/downtrend → trend; ranging → range. */
export type RegimeClass = "trend" | "range" | "volatile";
export function regimeClass(regime: Regime): RegimeClass {
  return regime === "uptrend" || regime === "downtrend" ? "trend" : regime === "ranging" ? "range" : "volatile";
}

/**
 * When regime-gating is ON (config.strategies.regimeGate): may a strategy whose measured-edge
 * regimes are `allowed` fire in the `current` regime? A strategy with no declared regimes is
 * never gated. (From `npm run regimeedge`: momentum strategies want trend, mean-reversion wants range.)
 */
export function regimeAllows(allowed: RegimeClass[] | undefined, current: RegimeClass): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(current);
}
