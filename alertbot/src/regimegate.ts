import "./env.js";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { buildConfirmPlan } from "./plan.js";
import { detectRange } from "./range.js";
import { detectRegime } from "./regime.js";
import { confirmsResistance, confirmsSupport } from "./signals.js";
import { STRATEGIES } from "./strategies.js";
import { resolveExit } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * `npm run regimegate` — does REGIME-GATING actually help at the PORTFOLIO level?
 *
 * `npm run regimeedge` showed each strategy is only +EV in some regimes (breakout-retest &
 * TSMOM in TRENDS, bollinger in RANGES). This validates the fix before wiring it into the live
 * bot: it runs the portfolio simulator (all symbols, one shared compounding balance) twice —
 * ungated (every signal) vs regime-gated (each strategy only fires in its +EV regime) — and
 * compares return / drawdown / risk-adjusted return (ret/maxDD). Only if gating clearly lifts
 * the whole account do we build it. Confirmations are left ungated (no per-regime data for them).
 * No lookahead. In-sample on one window — re-validate as history grows.
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const START = 60;
// From npm run regimeedge — the regime(s) each strategy showed a positive edge in.
const STRAT_REGIME: Record<string, string[]> = {
  "breakout-retest": ["trend"],
  "momentum-TSMOM": ["trend"],
  "bollinger-reversion": ["range"],
};
function classify(r: string): string {
  return r === "uptrend" || r === "downtrend" ? "trend" : r === "ranging" ? "range" : "volatile";
}

interface Sig { symbol: string; source: string; long: boolean; entry: number; stop: number; target: number; strat: boolean; regime: string }
interface Position extends Sig { openI: number; sizeUnits: number; riskUsd: number }

function signalsAt(symbol: string, window: Candle[]): Sig[] {
  const out: Sig[] = [];
  const last = window[window.length - 1]!;
  const regime = classify(detectRegime(window).regime);
  if (config.paper.takeStrategies) {
    for (const s of STRATEGIES) {
      if (!s.enabled()) continue;
      const sig = s.detect({ symbol, closed: window, price: last.close });
      if (!sig) continue;
      const risk = Math.abs(sig.entry - sig.stop);
      const reward = Math.abs(sig.target - sig.entry);
      if (risk <= 0 || reward / risk < config.paper.minRR) continue;
      out.push({ symbol, source: sig.strategy, long: sig.direction === "LONG", entry: sig.entry, stop: sig.stop, target: sig.target, strat: true, regime });
    }
  }
  if (config.paper.takeConfirmations) {
    const range = detectRange(window);
    if (range.consolidating) {
      let lvl: "support" | "resistance" | null = null;
      if (confirmsSupport(last, range)) lvl = "support";
      else if (confirmsResistance(last, range)) lvl = "resistance";
      if (lvl) {
        const p = buildConfirmPlan(lvl, range, last.close, true); // honest close fills (see npm run confirmedge)
        const risk = Math.abs(p.entry - p.stop);
        const reward = Math.abs(p.target - p.entry);
        if (risk > 0 && reward / risk >= config.paper.minRR) out.push({ symbol, source: lvl, long: p.direction === "LONG", entry: p.entry, stop: p.stop, target: p.target, strat: false, regime });
      }
    }
  }
  return out;
}

function allow(s: Sig, gated: boolean): boolean {
  if (!gated || !s.strat) return true;
  const regs = STRAT_REGIME[s.source];
  return !regs || regs.includes(s.regime);
}

function simulate(bySym: Record<string, Candle[]>, sigAt: Record<string, Sig[][]>, gated: boolean) {
  const feeRate = config.paper.feeBps / 10000;
  const slip = config.paper.slippageBps / 10000;
  const start: number = config.paper.startBalanceUsd;
  let balance = start;
  const open: Position[] = [];
  const rets: number[] = [];
  const curve: number[] = [start];
  const n = Math.min(...SYMBOLS.map((s) => bySym[s]?.length ?? 0));
  for (let i = START; i < n; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k]!;
      if (i <= p.openI) continue;
      const c = bySym[p.symbol]![i]!;
      const hit = resolveExit(p.long, p.stop, p.target, c.low, c.high, slip);
      if (hit) {
        const fees = feeRate * p.sizeUnits * (p.entry + hit.exit);
        const pnl = (p.long ? 1 : -1) * (hit.exit - p.entry) * p.sizeUnits - fees;
        balance += pnl;
        rets.push(p.riskUsd > 0 ? pnl / p.riskUsd : 0);
        curve.push(balance);
        open.splice(k, 1);
      }
    }
    for (const sym of SYMBOLS) {
      for (const sig of sigAt[sym]![i]!) {
        if (!allow(sig, gated)) continue;
        if (open.filter((o) => o.symbol === sym).length >= config.paper.maxOpenPerSymbol) continue;
        const risk = Math.abs(sig.entry - sig.stop);
        if (risk <= 0) continue;
        const riskUsd = (balance * config.paper.riskPct) / 100;
        open.push({ ...sig, openI: i, sizeUnits: riskUsd / risk, riskUsd });
      }
    }
  }
  const wins = rets.filter((r) => r > 0).length;
  let peak = start;
  let maxDD = 0;
  for (const b of curve) {
    if (b > peak) peak = b;
    const dd = peak > 0 ? ((peak - b) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const returnPct = ((balance - start) / start) * 100;
  return { trades: rets.length, winPct: rets.length ? (wins / rets.length) * 100 : 0, returnPct, maxDD, calmar: maxDD > 0 ? returnPct / maxDD : returnPct > 0 ? Infinity : 0, endBalance: balance };
}

async function main() {
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await getKlines(HISTORY, config.interval, s);
    if (c) bySym[s] = c.filter((x) => x.closed);
  }
  if (SYMBOLS.some((s) => !bySym[s])) {
    console.error("failed to fetch history");
    process.exit(1);
  }
  const sigAt: Record<string, Sig[][]> = {};
  for (const sym of SYMBOLS) {
    const c = bySym[sym]!;
    const arr: Sig[][] = [];
    for (let i = 0; i < c.length; i++) arr[i] = i >= START ? signalsAt(sym, c.slice(0, i + 1)) : [];
    sigAt[sym] = arr;
  }
  const off = simulate(bySym, sigAt, false);
  const gated = simulate(bySym, sigAt, true);

  console.log(`REGIME-GATING VALIDATION — portfolio, ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles, one shared $${config.paper.startBalanceUsd}`);
  console.log(`Gate: breakout-retest + TSMOM → trend only, bollinger → range only (from npm run regimeedge). Confirmations ungated.\n`);
  console.log("  variant        trades  win    return    maxDD    ret/DD    endBal");
  const row = (name: string, r: ReturnType<typeof simulate>) =>
    console.log(`  ${name.padEnd(13)} ${String(r.trades).padStart(5)}  ${(r.winPct.toFixed(0) + "%").padStart(4)}  ${((r.returnPct >= 0 ? "+" : "") + r.returnPct.toFixed(1) + "%").padStart(7)}  ${(r.maxDD.toFixed(1) + "%").padStart(6)}  ${(r.calmar === Infinity ? "inf" : r.calmar.toFixed(2)).padStart(6)}   $${r.endBalance.toFixed(0)}`);
  row("ungated", off);
  row("regime-gated", gated);

  const better = gated.calmar > off.calmar && gated.returnPct > 0;
  console.log(`\nVERDICT: regime-gating ${better ? "IMPROVES risk-adjusted return (higher ret/maxDD) → worth wiring into the live bot" : gated.returnPct > off.returnPct ? "raises return — check the drawdown trade-off before committing" : "does NOT clearly help at the portfolio level on this window — keep it opt-in and keep measuring"}. In-sample on one window; re-validate as history grows.`);
}

main().catch((e) => {
  console.error(`regimegate failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
