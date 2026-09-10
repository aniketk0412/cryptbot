import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { emaLast } from "./indicators.js";
import { detectRange } from "./range.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import { fvgFactor, premiumDiscountFactor, structureFactor, sweepFactor } from "./structure.js";
import type { Candle, Level } from "./types.js";

/**
 * `npm run audit` — the standing edge report. Replays recent history across your
 * watchlist and answers, with data not vibes:
 *   1) STRATEGY EDGE   — expectancy (avg R/trade) of each ENABLED strategy.
 *   2) CONFLUENCE EDGE — how many win-rate points each confirmation factor adds.
 * Re-run it whenever you want to re-check what's actually working. Saves data/audit.json.
 */

const SYMBOLS = config.watchlist;
const INTERVAL = config.interval;
const HISTORY = 1500;
const HORIZON = 48; // candles a strategy trade is held before mark-to-market
const START = 60;
const FACTORS = ["flow", "fvg", "sweep", "premium/discount", "structure", "HTF"] as const;
type FactorName = (typeof FACTORS)[number];

function agg(rs: number[]) {
  const n = rs.length;
  const w = rs.filter((r) => r > 0);
  const l = rs.filter((r) => r <= 0);
  const tot = rs.reduce((a, b) => a + b, 0);
  const gp = w.reduce((a, b) => a + b, 0);
  const gl = Math.abs(l.reduce((a, b) => a + b, 0));
  return { n, wins: w.length, losses: l.length, win: n ? (w.length / n) * 100 : 0, exp: n ? tot / n : 0, net: tot, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0 };
}

// ---------- 1) Strategy edge (fixed target, in R) ----------
function fixedR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  for (const c of future) {
    if (long) { if (c.low <= stop) return -1; if (c.high >= target) return (target - entry) / risk; }
    else { if (c.high >= stop) return -1; if (c.low <= target) return (entry - target) / risk; }
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}
function auditStrategies(bySym: Record<string, Candle[]>) {
  const strats = STRATEGIES.filter((s) => s.enabled());
  const trades: { strategy: string; R: number }[] = [];
  for (const sym of SYMBOLS) {
    const closed = bySym[sym];
    if (!closed) continue;
    const busy: Record<string, number> = {};
    for (let i = START; i < closed.length - 1; i++) {
      const ctx = { symbol: sym, closed: closed.slice(0, i + 1), price: closed[i]!.close };
      for (const strat of strats) {
        if ((busy[strat.name] ?? -1) >= i) continue;
        const sig = strat.detect(ctx);
        if (!sig || Math.abs(sig.entry - sig.stop) <= 0) continue;
        const long = sig.direction === "LONG";
        const future = closed.slice(i + 1, i + 1 + HORIZON);
        let gate = i + HORIZON;
        for (let j = 0; j < future.length; j++) {
          const c = future[j]!;
          if (long ? c.low <= sig.stop || c.high >= sig.target : c.high >= sig.stop || c.low <= sig.target) { gate = i + 1 + j; break; }
        }
        busy[strat.name] = gate;
        trades.push({ strategy: strat.name, R: fixedR(long, sig.entry, sig.stop, sig.target, future) });
      }
    }
  }
  return strats.map((s) => ({ strategy: s.name, ...agg(trades.filter((t) => t.strategy === s.name).map((t) => t.R)) })).sort((a, b) => b.exp - a.exp);
}

// ---------- 2) Confluence factor edge (on S/R confirmations) ----------
function outcomeOf(level: Level, entry: number, future: Candle[]): "win" | "loss" | "timeout" {
  const b = config.backtest;
  const target = level === "support" ? entry * (1 + b.targetPct / 100) : entry * (1 - b.targetPct / 100);
  const stop = level === "support" ? entry * (1 - b.stopPct / 100) : entry * (1 + b.stopPct / 100);
  for (const c of future) {
    if (level === "support") { if (c.low <= stop) return "loss"; if (c.high >= target) return "win"; }
    else { if (c.high >= stop) return "loss"; if (c.low <= target) return "win"; }
  }
  return "timeout";
}
function auditFactors(bySym: Record<string, Candle[]>, htfBySym: Record<string, Candle[]>) {
  const b = config.backtest;
  const sigs: { present: Record<FactorName, boolean>; outcome: "win" | "loss" | "timeout" }[] = [];
  for (const sym of SYMBOLS) {
    const closed = bySym[sym];
    const htf = htfBySym[sym] ?? [];
    if (!closed) continue;
    for (let i = config.lookback; i < closed.length - b.horizon; i++) {
      const window = closed.slice(0, i + 1);
      const range = detectRange(window);
      if (!range.consolidating) continue;
      const candle = closed[i]!;
      let level: Level | null = null;
      if (confirmsSupport(candle, range)) level = "support";
      else if (confirmsResistance(candle, range)) level = "resistance";
      if (!level) continue;
      const price = candle.close;
      const delta = 2 * candle.takerBuyVolume - candle.volume;
      const avail = htf.filter((c) => c.closeTime <= candle.closeTime);
      const enoughHtf = avail.length >= config.structure.htfEmaPeriod;
      const htfUp = enoughHtf && avail[avail.length - 1]!.close > emaLast(avail.map((c) => c.close), config.structure.htfEmaPeriod);
      const present: Record<FactorName, boolean> = {
        flow: level === "support" ? delta > 0 : delta < 0,
        fvg: fvgFactor(level, price, window).ok,
        sweep: sweepFactor(level, window).ok,
        "premium/discount": premiumDiscountFactor(level, price, window).ok,
        structure: structureFactor(level, window).ok,
        HTF: enoughHtf ? (level === "support" ? htfUp : !htfUp) : false,
      };
      sigs.push({ present, outcome: outcomeOf(level, price, closed.slice(i + 1, i + 1 + b.horizon)) });
    }
  }
  const dec = sigs.filter((s) => s.outcome !== "timeout");
  const wr = (arr: typeof dec) => (arr.length ? arr.filter((s) => s.outcome === "win").length / arr.length : 0);
  const rows = FACTORS.map((f) => {
    const withF = dec.filter((s) => s.present[f]);
    const woF = dec.filter((s) => !s.present[f]);
    return { factor: f, present: wr(withF) * 100, absent: wr(woF) * 100, nP: withF.length, nA: woF.length, edge: withF.length && woF.length ? (wr(withF) - wr(woF)) * 100 : NaN };
  }).sort((a, b) => (Number.isFinite(b.edge) ? b.edge : -99) - (Number.isFinite(a.edge) ? a.edge : -99));
  return { total: sigs.length, decisive: dec.length, winRate: wr(dec) * 100, rows };
}

async function main() {
  console.log(`EDGE AUDIT — ${SYMBOLS.join("/")} @ ${INTERVAL}, ${HISTORY} candles each\n`);
  const bySym: Record<string, Candle[]> = {};
  const htfBySym: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS) {
    const c = await getKlines(HISTORY, INTERVAL, sym);
    if (c) bySym[sym] = c.filter((x) => x.closed);
    const h = await getKlines(400, config.structure.htfInterval, sym);
    if (h) htfBySym[sym] = h.filter((x) => x.closed);
  }

  const strat = auditStrategies(bySym);
  console.log("1) STRATEGY EDGE — expectancy (avg R/trade), fixed target. Positive = edge, negative = bleeds.");
  console.log("   strategy               trades  win%    avgR     net R    PF");
  for (const r of strat) {
    const pf = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
    console.log(`   ${r.strategy.padEnd(20)} ${String(r.n).padStart(5)}   ${r.win.toFixed(0).padStart(3)}%  ${((r.exp >= 0 ? "+" : "") + r.exp.toFixed(3)).padStart(7)}R  ${((r.net >= 0 ? "+" : "") + r.net.toFixed(1) + "R").padStart(8)}  ${pf.padStart(5)}`);
  }

  const fac = auditFactors(bySym, htfBySym);
  console.log(`\n2) CONFLUENCE EDGE — ${fac.decisive} decisive S/R confirmations, ${fac.winRate.toFixed(0)}% base win rate.`);
  console.log("   factor               present       absent        edge");
  for (const r of fac.rows) {
    const e = Number.isFinite(r.edge) ? `${r.edge >= 0 ? "+" : ""}${r.edge.toFixed(1)}pp` : "—";
    console.log(`   ${r.factor.padEnd(18)} ${(r.present.toFixed(0) + "% (" + r.nP + ")").padStart(12)}  ${(r.absent.toFixed(0) + "% (" + r.nA + ")").padStart(12)}  ${e.padStart(8)}`);
  }

  const out = { generatedAt: new Date().toISOString(), interval: INTERVAL, symbols: SYMBOLS, strategies: strat, factors: fac };
  await mkdir(dirname("data/audit.json"), { recursive: true });
  await writeFile("data/audit.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/audit.json");
}
main().catch((e) => { console.error(`audit failed: ${(e as Error).stack ?? e}`); process.exit(1); });
