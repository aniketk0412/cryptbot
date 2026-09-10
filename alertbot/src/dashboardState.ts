import { resolveExit } from "./paperexit.js";
import type { Candle, TradePlan } from "./types.js";

/** One alert as shown on the dashboard. */
export interface AlertLog {
  time: string;
  symbol: string;
  kind: string; // touch | confirmation | breakout | strategy
  level: string; // resistance | support
  direction?: string; // LONG | SHORT (strategy alerts)
  strategyName?: string;
  levelPrice: number;
  score?: string; // e.g. "6/8 STRONG"
  factors?: { ok: boolean; label: string }[];
  context?: string[];
  plan?: TradePlan;
  bet?: import("./evidence.js").Bet;
  signalCloseTime?: number; // set on committed entry alerts (confirmation/strategy/reversal) → outcome-tracked
  outcome?: "open" | "win" | "loss"; // did the call hit its target (win) or stop (loss) yet?
  message: string;
}

/** Per-symbol market snapshot the dashboard renders. */
export interface SymbolSnapshot {
  symbol: string;
  interval: string;
  levelMode: string;
  price: number;
  high: number; // resistance
  low: number; // support
  widthPct: number;
  consolidating: boolean;
  resArmed: boolean;
  supArmed: boolean;
  toR: number;
  toS: number;
  spoof?: { suspected: boolean; note: string; pulls: number };
  divergences?: string[]; // e.g. ["RSI bullish", "CVD bearish"]
  regime?: { regime: string; note: string };
  liq?: { count: number; longUsd: number; shortUsd: number; cascade: boolean; note: string };
  bias?: { dir: "LONG" | "SHORT" | "WAIT"; reason: string };
  ob?: {
    bull?: { low: number; high: number; avg: number };
    bear?: { low: number; high: number; avg: number };
  };
  sweep?: { type: string; level: number; time: number };
  vp?: { poc: number; vah: number; val: number }; // volume profile: point of control + value area
  mtf?: import("./mtf.js").MtfTf[]; // multi-timeframe trend context (15m / 1h / 4h / 1d)
  context?: import("./context.js").SymbolContext; // market-context HUD read (funding/OI/L-S/flow) — DISCRETIONARY context, NOT a signal
}

/** Live snapshot the dashboard polls. Single-process, so plain mutation is safe. */
export interface DashboardState {
  telegram: boolean;
  updatedAt: string;
  symbols: SymbolSnapshot[];
  alerts: AlertLog[]; // most recent first, across all symbols
  feeds: import("./feeds.js").FeedStatus[]; // live health of the WebSocket data feeds
  market?: { regime: "bull" | "bear" | "flat"; filterActive: boolean; trendPct?: number; lookbackBars?: number; bandPct?: number; allowedRegimes?: ("bull" | "bear" | "flat")[] }; // broad-market regime, its trailing basket %, the lookback (bars) + band that classify it, and which regimes the filtered account may open in
}

export const state: DashboardState = { telegram: false, updatedAt: "", symbols: [], alerts: [], feeds: [] };

/** Record an alert for the dashboard (capped ring buffer). */
export function pushAlert(a: AlertLog): void {
  state.alerts.unshift(a);
  if (state.alerts.length > 50) state.alerts.length = 50;
}

/** Upsert one symbol's snapshot into the dashboard state. */
export function syncSymbol(snap: Omit<SymbolSnapshot, "toR" | "toS">): void {
  const full: SymbolSnapshot = {
    ...snap,
    toR: snap.price > 0 ? ((snap.high - snap.price) / snap.price) * 100 : 0,
    toS: snap.price > 0 ? ((snap.price - snap.low) / snap.price) * 100 : 0,
  };
  const i = state.symbols.findIndex((s) => s.symbol === snap.symbol);
  if (i >= 0) state.symbols[i] = full;
  else state.symbols.push(full);
  state.updatedAt = new Date().toISOString();
}

/**
 * Track each committed alert's real outcome: from the signal candle, follow price until it
 * first touches the plan's target (WIN) or stop (LOSS) — same first-touch, stop-first rule the
 * paper engine uses. Lets the alert feed show, inline, how each call actually resolved. Only
 * entry alerts carry `signalCloseTime` (touch/breakout don't), so only those get tracked.
 */
export function evaluateAlerts(symbol: string, candles: Candle[]): void {
  const closed = candles.filter((c) => c.closed);
  for (const a of state.alerts) {
    if (a.symbol !== symbol || !a.plan || a.signalCloseTime == null) continue;
    if (a.outcome === "win" || a.outcome === "loss") continue; // already resolved
    let resolved: "win" | "loss" | null = null;
    for (const c of closed) {
      if (c.closeTime <= a.signalCloseTime) continue;
      const hit = resolveExit(a.plan.direction === "LONG", a.plan.stop, a.plan.target, c.low, c.high, 0);
      if (hit) { resolved = hit.reason === "target" ? "win" : "loss"; break; }
    }
    a.outcome = resolved ?? "open";
  }
}
