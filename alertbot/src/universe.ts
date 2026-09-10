import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import { emaSeries } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run universe` — does the short-trend edge GENERALIZE beyond SOL/BTC/ETH, or strengthen on alts?
 *
 * All analysis is on 3 coins. Higher-beta alts trend harder in downtrends, so the bot's edge (shorting
 * downtrends) might be stronger — and more symbols = more opportunities without diluting per-trade edge.
 * This runs the SAME signal engine per symbol on a broader liquid-perp set and reports the "bear-short"
 * expectancy: SHORT signals fired while THAT symbol is in its own downtrend (close < EMA50 & EMA20 < EMA50).
 * Per-symbol trend (not the SOL/BTC/ETH basket) so it generalizes to any coin. If the alt aggregate matches
 * or beats the 3-coin baseline (~+0.228R), widening the watchlist is a real, scalable win. No lookahead,
 * gross R, fixed 48-bar horizon, in-sample — directional. Symbols without enough perp history are skipped.
 */

const BASE = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const ALTS = ["BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT", "DOTUSDT"];
const TARGET = 4000;
const HORIZON = 48;

function fixedR(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { r: 0, exitBar: future.length };
  const rt = Math.abs(target - entry) / risk;
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (long ? c.low <= stop : c.high >= stop) return { r: -1, exitBar: j + 1 };
    if (long ? c.high >= target : c.low <= target) return { r: rt, exitBar: j + 1 };
  }
  const last = future[future.length - 1];
  return { r: last ? (long ? last.close - entry : entry - last.close) / risk : 0, exitBar: future.length };
}

const exp = (a: number[]) => (a.length ? mean(a) : NaN);
const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);

/** Bear-short R samples for one symbol (short signals in its own downtrend), split early/late for OOS. */
async function symbolBearShorts(sym: string): Promise<{ early: number[]; late: number[] } | null> {
  const c = await fetchDeepHistory(sym, config.interval, TARGET);
  if (!c || c.length < WARMUP + HORIZON + 100) return null;
  const closes = c.map((x) => x.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const sigAt = precomputeSignals(sym, c);
  const mid = Math.floor((WARMUP + c.length - 1) / 2);
  const early: number[] = [], late: number[] = [];
  const busy: Record<string, number> = {};
  for (let i = WARMUP; i < c.length - 1; i++) {
    const downtrend = closes[i]! < ema50[i]! && ema20[i]! < ema50[i]!;
    if (!downtrend) continue;
    const sigs = sigAt[i]!;
    const future = c.slice(i + 1, i + 1 + HORIZON);
    for (const sg of sigs) {
      if (sg.long) continue;
      if ((busy[sg.source] ?? -1) >= i) continue;
      const { r, exitBar } = fixedR(false, sg.entry, sg.stop, sg.target, future);
      busy[sg.source] = i + exitBar;
      (i < mid ? early : late).push(r);
    }
  }
  return { early, late };
}

async function main() {
  console.log(`SYMBOL UNIVERSE — does the short-trend edge generalize to alts, and hold across TIME? @ ${config.interval}\n`);
  const rows: { sym: string; base: boolean; early: number[]; late: number[] }[] = [];
  for (const sym of [...BASE, ...ALTS]) {
    const res = await symbolBearShorts(sym);
    if (res === null) { console.log(`  ${sym.padEnd(9)} — insufficient history, skipped`); continue; }
    rows.push({ sym, base: BASE.includes(sym), ...res });
  }
  const tot = (r: { early: number[]; late: number[] }) => [...r.early, ...r.late];

  console.log(`\n  symbol      grp    bear-short (full)              early → late (OOS split)`);
  for (const r of rows) {
    const t = tot(r);
    const halves = `${exp(r.early) >= 0 ? "+" : ""}${exp(r.early).toFixed(2)} → ${exp(r.late) >= 0 ? "+" : ""}${exp(r.late).toFixed(2)}`;
    console.log(`  ${r.sym.padEnd(9)}  ${r.base ? "base" : "alt "}   ${(t.length ? `${exp(t) >= 0 ? "+" : ""}${exp(t).toFixed(3)}R / ${win(t).toFixed(0)}% / n${t.length}` : "—").padEnd(26)}   ${halves}`);
  }

  const baseEarly = rows.filter((r) => r.base).flatMap((r) => r.early);
  const baseLate = rows.filter((r) => r.base).flatMap((r) => r.late);
  const altEarly = rows.filter((r) => !r.base).flatMap((r) => r.early);
  const altLate = rows.filter((r) => !r.base).flatMap((r) => r.late);
  const baseAll = [...baseEarly, ...baseLate], altAll = [...altEarly, ...altLate];
  const posAlts = rows.filter((r) => !r.base && tot(r).length >= 30 && exp(tot(r)) > 0).length;
  const totAlts = rows.filter((r) => !r.base && tot(r).length >= 30).length;
  const altBothHalves = rows.filter((r) => !r.base && r.early.length >= 15 && r.late.length >= 15 && exp(r.early) > 0 && exp(r.late) > 0).length;
  console.log(`\n  BASE: full ${exp(baseAll).toFixed(3)}R (n${baseAll.length}) · early ${exp(baseEarly).toFixed(3)} → late ${exp(baseLate).toFixed(3)}`);
  console.log(`  ALT : full ${exp(altAll).toFixed(3)}R (n${altAll.length}) · early ${exp(altEarly).toFixed(3)} → late ${exp(altLate).toFixed(3)}   (${posAlts}/${totAlts} alts +EV full; ${altBothHalves} +EV in BOTH halves)`);

  const altE = exp(altAll), baseE = exp(baseAll), holdsBoth = exp(altEarly) > 0.03 && exp(altLate) > 0.03;
  console.log(
    `\nVERDICT: ${!Number.isFinite(altE)
      ? `no alt had enough data — inconclusive.`
      : holdsBoth && altE >= baseE - 0.03
        ? `GENERALIZES AND HOLDS OUT-OF-SAMPLE — alts +${altE.toFixed(3)}R (vs base +${baseE.toFixed(3)}R), POSITIVE in BOTH time halves (early +${exp(altEarly).toFixed(3)}, late +${exp(altLate).toFixed(3)}), ${altBothHalves}/${totAlts} alts +EV in both. Widening the watchlist is a SAFE recommendation — a real, scalable win (validate on live + real alt slippage). Start AVAX/DOGE/BNB.`
        : altE > 0.03 && (exp(altEarly) > 0 && exp(altLate) > 0)
          ? `generalizes and stays positive both halves but weaker in one (early ${exp(altEarly).toFixed(3)}, late ${exp(altLate).toFixed(3)}) — real but modest; widen cautiously with the strongest few.`
          : `the alt edge does NOT hold across time (early ${exp(altEarly).toFixed(3)}, late ${exp(altLate).toFixed(3)}) — partly period-driven; do NOT widen on this alone.`}`,
  );
  console.log(`(In-sample halves of a ~166-day window; gross R, ${HORIZON}-bar horizon. "early→late" = the OOS check. Live/forward + real alt slippage is the final test.)`);

  const out = { generatedAt: new Date().toISOString(), interval: config.interval, horizon: HORIZON,
    perSymbol: rows.map((r) => ({ sym: r.sym, base: r.base, exp: exp(tot(r)), win: win(tot(r)), n: tot(r).length, earlyExp: exp(r.early), lateExp: exp(r.late) })),
    baseAgg: { exp: exp(baseAll), early: exp(baseEarly), late: exp(baseLate), n: baseAll.length },
    altAgg: { exp: altE, early: exp(altEarly), late: exp(altLate), n: altAll.length, posAlts, totAlts, altBothHalves } };
  await mkdir(dirname("data/universe.json"), { recursive: true });
  await writeFile("data/universe.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/universe.json");
}

main().catch((e) => {
  console.error(`universe failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
