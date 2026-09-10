import { readFile } from "node:fs/promises";

/**
 * EVIDENCE ENGINE — turns each signal into a math-backed BET instead of a guess.
 *
 * Every analytical factor is a "worker" carrying its MEASURED historical edge
 * (win-rate lift in points, from `npm run audit` → data/audit.json; baked fallback
 * below until the first audit runs). `assessBet()` is the trading desk: it aggregates
 * the workers into an estimated win %, a grade, and the full reasoning trail behind
 * the read — so every alert says WHY, backed by numbers, not vibes.
 */

interface FactorEdge { factor: string; edge: number; nP: number } // edge = win-rate lift (percentage points)
interface StratEdge { strategy: string; win: number; exp: number; n: number }

// Last committed audit (SOL/BTC/ETH 1h, 1500 candles, refreshed 2026-07-09).
// These are the fallback until `npm run audit` writes a fresh data/audit.json.
const BAKED = {
  confirmBaseWin: 44,
  factors: [
    { factor: "flow", edge: 20.2, nP: 101 },
    { factor: "fvg", edge: 20.2, nP: 123 },
    { factor: "HTF", edge: 7.6, nP: 26 },
    { factor: "premium/discount", edge: -4.6, nP: 144 },
    { factor: "structure", edge: -10.5, nP: 3 },
    { factor: "sweep", edge: -14.2, nP: 89 },
  ] as FactorEdge[],
  strategies: [
    { strategy: "breakout-retest", win: 26, exp: 0.19, n: 125 },
    { strategy: "momentum-TSMOM", win: 48, exp: 0.055, n: 75 },
    { strategy: "bollinger-reversion", win: 53, exp: 0.079, n: 270 },
  ] as StratEdge[],
};

let model = BAKED;
let loaded = false;

/** Refresh the edge model from the latest `npm run audit` output, if present. */
export async function loadEdge(): Promise<void> {
  if (loaded) return;
  try {
    const a = JSON.parse(await readFile("data/audit.json", "utf8"));
    if (a?.factors?.rows && Array.isArray(a.strategies)) {
      model = {
        confirmBaseWin: typeof a.factors.winRate === "number" ? a.factors.winRate : BAKED.confirmBaseWin,
        factors: a.factors.rows.filter((r: FactorEdge) => Number.isFinite(r.edge)).map((r: FactorEdge) => ({ factor: r.factor, edge: r.edge, nP: r.nP })),
        strategies: a.strategies.map((s: StratEdge) => ({ strategy: s.strategy, win: s.win, exp: s.exp, n: s.n })),
      };
    }
  } catch {
    // keep baked model
  }
  loaded = true;
}

export interface Worker { name: string; present: boolean; liftPp: number; lowN: boolean }
export type Grade = "STRONG" | "OK" | "WEAK" | "AVOID";
export interface Bet {
  grade: Grade;
  winPct: number; // estimated win probability (base rate nudged by confluence)
  measuredExpR: number | null; // the strategy's own measured expectancy in R (null for S/R confirmations)
  measuredWin: number | null;
  sampleN: number | null; // trades behind the measured number
  netConfluencePp: number; // sum of present workers' measured edges
  basis: string; // one-line human summary of the evidence
  workers: Worker[]; // full reasoning trail
}

const LOW_N = 25;

/**
 * Assess a signal into an evidence-backed bet.
 *  - `source`         : strategy name, or "support"/"resistance"/"failed-breakout"
 *  - `rr`             : the plan's reward:risk
 *  - `factorsPresent` : which measured confluence factors fired (keyed by factor name)
 */
export function assessBet(opts: { source: string; rr: number; factorsPresent: Record<string, boolean> }): Bet {
  const strat = model.strategies.find((s) => s.strategy === opts.source);
  const base = strat ? strat.win : model.confirmBaseWin;

  const workers: Worker[] = model.factors.map((f) => ({
    name: f.factor,
    present: !!opts.factorsPresent[f.factor],
    liftPp: f.edge,
    lowN: f.nP < LOW_N,
  }));
  // Present factors' edge, skipping absurd low-sample outliers (they're noise, not evidence).
  const counted = workers.filter((w) => w.present && !(w.lowN && Math.abs(w.liftPp) > 25));
  const netConfluencePp = counted.reduce((s, w) => s + w.liftPp, 0);

  // Estimated win% = base rate nudged by confluence, halved for factor correlation, clamped.
  const winPct = Math.max(8, Math.min(92, base + 0.5 * netConfluencePp));
  const p = winPct / 100;
  // Cap the reward: even a far target rarely averages more than ~3R of realized win
  // (price reverses / times out first), so full-R:R would overstate high-target setups.
  const estExp = p * Math.min(opts.rr, 3) - (1 - p);

  // Grade off the strategy's MEASURED expectancy when we have it (trustworthy), nudged by
  // confluence sign; otherwise off the confluence-based estimate.
  const anchor = strat ? strat.exp + netConfluencePp / 300 : estExp;
  const grade: Grade = anchor >= 0.3 ? "STRONG" : anchor >= 0.12 ? "OK" : anchor >= 0 ? "WEAK" : "AVOID";

  const basis = strat
    ? `${opts.source}: measured ${strat.exp >= 0 ? "+" : ""}${strat.exp.toFixed(2)}R / ${strat.win.toFixed(0)}% over ${strat.n} trades`
    : `S/R confirmation — ${base.toFixed(0)}% base ${netConfluencePp >= 0 ? "+" : ""}${netConfluencePp.toFixed(0)}pp confluence`;

  return {
    grade,
    winPct,
    measuredExpR: strat ? strat.exp : null,
    measuredWin: strat ? strat.win : null,
    sampleN: strat ? strat.n : null,
    netConfluencePp,
    basis,
    workers,
  };
}

/** Compact one-line read for terminal / Telegram. */
export function betLine(b: Bet): string {
  const meas = b.measuredExpR != null ? ` · ${b.measuredExpR >= 0 ? "+" : ""}${b.measuredExpR.toFixed(2)}R measured (${b.sampleN}n)` : "";
  return `${b.grade} · ~${b.winPct.toFixed(0)}% win${meas} · confluence ${b.netConfluencePp >= 0 ? "+" : ""}${b.netConfluencePp.toFixed(0)}pp`;
}

/** Map a live confluence factor list to the measured-factor presence the engine reads. */
export function factorsFromConfluence(factors: { ok: boolean; label: string }[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of factors) {
    const l = f.label.toLowerCase();
    const k = l.includes("flow")
      ? "flow"
      : l.includes("fvg")
        ? "fvg"
        : l.includes("sweep") || l.includes("swept")
          ? "sweep"
          : l.includes("discount") || l.includes("premium")
            ? "premium/discount"
            : l.includes("structure")
              ? "structure"
              : l.includes("htf")
                ? "HTF"
                : null;
    if (k) out[k] = f.ok;
  }
  return out;
}
